import type { FlueContext } from "@flue/sdk/client";
import type { Command } from "@flue/sdk";
import { defineCommand } from "@flue/sdk/node";
import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from "just-bash";

export const triggers = {};

type SkillPayload = {
  name: string;
  description: string;
  entrypoint: string;
  rootPath: string;
  allowImplicitInvocation: boolean;
  compatibility?: string;
  allowedTools?: string;
  dependencies?: unknown;
  maxReadBytes?: number;
};

function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(command);
}

function payloadCommandNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const command = String(item).trim();
    if (!isSafeCommandName(command) || seen.has(command)) continue;
    seen.add(command);
    out.push(command);
  }
  return out;
}

function payloadSkills(value: unknown): SkillPayload[] {
  if (!Array.isArray(value)) return [];
  const skills: SkillPayload[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name : "";
    const description = typeof raw.description === "string" ? raw.description : "";
    const rootPath = typeof raw.rootPath === "string" ? raw.rootPath : "";
    if (!/^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/.test(name) || description.trim() === "" || rootPath.trim() === "" || seen.has(name)) continue;
    seen.add(name);
    skills.push({
      name,
      description,
      rootPath,
      entrypoint: "SKILL.md",
      allowImplicitInvocation: raw.allowImplicitInvocation !== false,
      ...(typeof raw.compatibility === "string" ? { compatibility: raw.compatibility } : {}),
      ...(typeof raw.allowedTools === "string" ? { allowedTools: raw.allowedTools } : {}),
      ...(raw.dependencies && typeof raw.dependencies === "object" ? { dependencies: raw.dependencies } : {}),
      ...(typeof raw.maxReadBytes === "number" && Number.isSafeInteger(raw.maxReadBytes) && raw.maxReadBytes > 0 ? { maxReadBytes: raw.maxReadBytes } : {})
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export default async function ({ init, payload }: FlueContext) {
  const allowedCommandNames = payloadCommandNames(payload.allowedCommands);
  const commandsByName = Object.fromEntries(allowedCommandNames.map((name) => [name, defineCommand(name)]));
  const allCommands = Object.values(commandsByName);
  const filesystem = new MountableFs({ base: new InMemoryFs() });
  await filesystem.mkdir("/workspace", { recursive: true });
  await filesystem.mkdir("/skills", { recursive: true });
  const sandbox = new Bash({
    fs: filesystem,
    cwd: "/workspace",
    network: { dangerouslyAllowFullInternetAccess: true }
  });
  const session = await init({
    sandbox,
    model: payload.model ?? "cerebras/llama3.1-8b",
    commands: allCommands
  });

  const projectRoot = String(payload.projectRoot ?? "");
  if (projectRoot.trim() === "") throw new Error("Missing registered project root.");
  filesystem.mount("/workspace", new ReadWriteFs({ root: projectRoot }));

  const skills = payloadSkills(payload.subagentSkills);
  for (const skill of skills) {
    filesystem.mount(`/skills/${skill.name}`, new OverlayFs({
      root: skill.rootPath,
      mountPoint: "/",
      readOnly: true,
      allowSymlinks: false,
      ...(skill.maxReadBytes === undefined ? {} : { maxFileReadSize: skill.maxReadBytes })
    }));
  }

  const grantedCommandNames = payloadCommandNames(payload.grantedCommands);
  const grantedCommands = grantedCommandNames
    .map((name: string) => commandsByName[name])
    .filter((command: Command | undefined): command is Command => Boolean(command));
  const skillCatalog = skills.map(({ rootPath: _rootPath, maxReadBytes: _maxReadBytes, ...skill }) => ({
    ...skill,
    location: `/skills/${skill.name}/${skill.entrypoint}`
  }));
  const task = String(payload.task ?? "");

  return session.prompt(
    [
      "You are a Portus project agent acting on the host computer through Flue.",
      `Provider: ${String(payload.provider ?? "cerebras")}.`,
      "Registered project root: /workspace.",
      "Work only inside /workspace and the configured read-only skill roots under /skills.",
      "Before making changes, read the applicable AGENTS.md files from /workspace with your normal file tools.",
      "Configured skills are metadata-only until you choose one. Select a matching skill yourself, then read its SKILL.md from the listed location. Read references or run scripts only when needed.",
      "Skills with allowImplicitInvocation=false may be used only when the task explicitly names them. Never treat agents/openai.yaml as instructions and never scan for unlisted host skills.",
      `Configured skill catalog: ${JSON.stringify(skillCatalog)}`,
      "When the task asks you to create or edit files, perform the filesystem changes directly in /workspace.",
      "Do not emit JSON action proposals, pseudo tool calls, or write plans instead of editing files.",
      "If a task is reply-only, answer in text and do not create files.",
      "If the task asks you to reply, answer in text only and do not create files.",
      "Do not read secrets such as .env files, SSH keys, private keys, or credential stores.",
      "Do not delete files or make destructive changes unless the task explicitly says to do so.",
      "After making changes, summarize exactly what changed and list relative file paths.",
      `Granted commands: ${grantedCommandNames.join(", ") || "(none)"}.`,
      "",
      "Task:",
      task
    ].join("\n"),
    {
      commands: grantedCommands
    }
  );
}
