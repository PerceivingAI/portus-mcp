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
    if (typeof item === "string") {
      const name = item.trim();
      if (name && isSafeCommandName(name) && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

function payloadSkills(value: unknown): SkillPayload[] {
  if (!Array.isArray(value)) return [];
  const skills: SkillPayload[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const description = typeof rec.description === "string" ? rec.description.trim() : "";
    const entrypoint = typeof rec.entrypoint === "string" ? rec.entrypoint.trim() : "";
    const rootPath = typeof rec.rootPath === "string" ? rec.rootPath.trim() : "";
    const allowImplicitInvocation = typeof rec.allowImplicitInvocation === "boolean" ? rec.allowImplicitInvocation : false;
    const compatibility = typeof rec.compatibility === "string" ? rec.compatibility : undefined;
    const allowedTools = typeof rec.allowedTools === "string" ? rec.allowedTools : undefined;
    const dependencies = rec.dependencies;
    const maxReadBytes = typeof rec.maxReadBytes === "number" && Number.isFinite(rec.maxReadBytes) ? rec.maxReadBytes : undefined;
    if (name && entrypoint && rootPath && !seen.has(name)) {
      seen.add(name);
      skills.push({ name, description, entrypoint, rootPath, allowImplicitInvocation, compatibility, allowedTools, dependencies, maxReadBytes });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export default async function ({ init, payload }: FlueContext) {
  const allowedCommandNames = payloadCommandNames(payload.allowedCommands);
  const commandsByName = Object.fromEntries(allowedCommandNames.map((name) => [name, defineCommand(name)]));
class ReadOnlyFs extends ReadWriteFs {
  override async writeFile(path: string, content: unknown, options?: unknown): Promise<void> {
    throw new Error(`EROFS: read-only file system, write '${path}'`);
  }
  override async appendFile(path: string, content: unknown, options?: unknown): Promise<void> {
    throw new Error(`EROFS: read-only file system, append '${path}'`);
  }
  override async mkdir(path: string, options?: unknown): Promise<void> {
    throw new Error(`EROFS: read-only file system, mkdir '${path}'`);
  }
  override async rm(path: string, options?: unknown): Promise<void> {
    throw new Error(`EROFS: read-only file system, rm '${path}'`);
  }
  override async chmod(path: string, mode: number): Promise<void> {
    throw new Error(`EROFS: read-only file system, chmod '${path}'`);
  }
}
  const allCommands = Object.values(commandsByName);
  const filesystem = new MountableFs({ base: new InMemoryFs() });
  await filesystem.mkdir("/workspace", { recursive: true });
  await filesystem.mkdir("/skills", { recursive: true });
  const projectRoot = String(payload.projectRoot ?? "");
  if (projectRoot.trim() === "") throw new Error("Missing registered project root.");
  filesystem.mount("/workspace", new ReadWriteFs({ root: projectRoot }));


  const skills = payloadSkills(payload.subagentSkills);
  for (const skill of skills) {
    const skillPath = `/skills/${skill.name}`;
    await filesystem.mkdir(skillPath, { recursive: true });
    filesystem.mount(skillPath, new ReadOnlyFs({ root: skill.rootPath, maxReadBytes: skill.maxReadBytes }));
  }

  const sandbox = new Bash({ fs: filesystem, cwd: "/workspace" });

  const grantedCommandNames = payloadCommandNames(payload.grantedCommands);
  const grantedCommands = grantedCommandNames
    .map((name: string) => commandsByName[name])
    .filter((command: Command | undefined): command is Command => Boolean(command));
  const skillCatalog = skills.map(({ rootPath: _rootPath, maxReadBytes: _maxReadBytes, ...skill }) => ({ ...skill, rootAlias: `skill/${skill.name}` }));
  const task = String(payload.task ?? "");
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const rawModel = typeof payload.model === "string" ? payload.model : "";
  const model = rawModel.includes("/") ? rawModel : (provider && rawModel ? `${provider}/${rawModel}` : (rawModel || undefined));
  const session = await init({
    model,
    commands: allCommands,
    sandbox
  });

  return session.prompt(
    [
      `You are a Portus subagent assigned to work in registered project root: ${projectRoot}.`,
      "Your workspace is mounted at /workspace. All file operations take place inside /workspace.",
      "Skill roots are mounted read-only at /skills/<skill-name>.",
      `Skill catalog: ${JSON.stringify(skillCatalog, null, 2)}`,
      "To use a skill, read /skills/<skill-name>/<entrypoint> (default SKILL.md). Read referenced files inside /skills/<skill-name>/ only when needed.",
      skillCatalog.length > 0 ? "Available subagent skills:" : "No subagent skills are configured for this session.",
      ...skillCatalog.map((s) => `- ${s.name}: ${s.description}`),
      `Allowed shell commands: ${grantedCommandNames.join(", ")}`,
      grantedCommandNames.length > 0 ? "Use shell commands directly when needed." : "No shell commands are granted for this session.",
      `Assigned task: ${task}`
    ].join("\n\n"),
    {
      commands: grantedCommands
    }
  );
}
