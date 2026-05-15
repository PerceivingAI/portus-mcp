import type { FlueContext } from "@flue/sdk/client";
import { defineCommand } from "@flue/sdk/node";

export const triggers = {};

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

export default async function ({ init, payload }: FlueContext) {
  const allowedCommandNames = payloadCommandNames(payload.allowedCommands);
  const commandsByName = Object.fromEntries(allowedCommandNames.map((name) => [name, defineCommand(name)]));
  const allCommands = Object.values(commandsByName);
  const session = await init({
    sandbox: "local",
    model: payload.model ?? "cerebras/llama3.1-8b",
    commands: allCommands
  });
  const grantedCommandNames = payloadCommandNames(payload.grantedCommands);
  const grantedCommands = grantedCommandNames
    .map((name: string) => commandsByName[name])
    .filter((command: ReturnType<typeof defineCommand> | undefined): command is ReturnType<typeof defineCommand> => Boolean(command));

  const task = String(payload.task ?? "");
  const projectRoot = String(payload.projectRoot ?? "");

  return session.prompt(
    [
      "You are a Portus project agent acting on the host computer through Flue.",
      `Provider: ${String(payload.provider ?? "cerebras")}.`,
      `Registered project root: ${projectRoot}.`,
      "Work only inside the current project workspace. Never operate outside the registered project root.",
      "When the task asks you to create or edit files, perform the filesystem changes directly in the workspace.",
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
