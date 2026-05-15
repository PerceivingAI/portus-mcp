import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { registerTool } from "./toolUtils.js";
import { runFlueTask } from "../flue/runTask.js";
import { assertChatGptPermission } from "../policy/permissionPolicy.js";
import { toPublicSession } from "../state/SessionRegistry.js";

const maxSkillReadBytes = 200000;

export function registerSkillTools(server: McpServer): void {
  registerTool(server, "skill_list", "Use this when ChatGPT needs to list available local Portus agent skills.", {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async () => {
    return { skills: listSkillMetadata() };
  });

  registerTool(server, "skill_read", "Use this when ChatGPT needs to read the full contents of a local skill folder.", {
    skillName: z.string()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ skillName }) => {
    return readFullSkill(skillName);
  });

  registerTool(server, "skill_run", "Use this when ChatGPT needs to run a local skill against a registered project.", {
    projectAlias: z.string(),
    skillName: z.string(),
    task: z.string(),
    timeoutSecs: z.number().int().positive().optional()
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, async ({ projectAlias, skillName, task, timeoutSecs }) => {
    assertChatGptPermission("spawnAgents", projectAlias);
    const config = loadConfig();
    const skill = readFullSkill(skillName);
    return toPublicSession(await runFlueTask({
      projectAlias,
      agentTemplate: config.agents.defaultTemplate,
      timeoutSecs,
      task: [
        `Use the following skill for this task.`,
        "",
        `Skill: ${skillName}`,
        "",
        formatSkillForPrompt(skill),
        "",
        "Task:",
        task
      ].join("\n")
    }));
  });
}

export function readSkill(skillName: string): string {
  const skill = readFullSkill(skillName);
  const entrypoint = skill.files.find((file) => file.relativePath === "SKILL.md");
  if (!entrypoint) {
    throw new Error(`Skill not found: ${skillName}.`);
  }
  return entrypoint.content;
}

function normalizeSkillName(skillName: string): string {
  const name = skillName.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid skill name: ${skillName}.`);
  }
  return name;
}

type SkillMetadata = {
  name: string;
  description: string;
};

type SkillFile = {
  relativePath: string;
  content: string;
  bytes: number;
};

type FullSkill = SkillMetadata & {
  path: string;
  entrypoint: string;
  files: SkillFile[];
  totalBytes: number;
};

function listSkillMetadata(): SkillMetadata[] {
  const config = loadConfig();
  const dir = path.resolve(config.skills.directory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => {
      const entrypoint = path.join(dir, item.name, "SKILL.md");
      if (!existsSync(entrypoint)) return null;
      const metadata = parseSkillFrontmatter(readFileSync(entrypoint, "utf8"), item.name);
      if (metadata.name !== item.name) {
        throw new Error(`Invalid skill ${item.name}: frontmatter name must match folder name.`);
      }
      return metadata;
    })
    .filter((skill): skill is SkillMetadata => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readFullSkill(skillName: string): FullSkill {
  const safeName = normalizeSkillName(skillName);
  const config = loadConfig();
  const skillsRoot = path.resolve(config.skills.directory);
  const skillRoot = path.resolve(skillsRoot, safeName);
  if (!skillRoot.startsWith(`${skillsRoot}${path.sep}`)) {
    throw new Error(`Invalid skill name: ${skillName}.`);
  }
  const entrypointFile = path.join(skillRoot, "SKILL.md");
  if (!existsSync(entrypointFile)) {
    throw new Error(`Skill not found: ${safeName}.`);
  }
  const metadata = parseSkillFrontmatter(readFileSync(entrypointFile, "utf8"), safeName);
  if (metadata.name !== safeName) {
    throw new Error(`Invalid skill ${safeName}: frontmatter name must match folder name.`);
  }

  let totalBytes = 0;
  const files = listBundledFiles(skillRoot).sort().map((relativePath) => {
    const absolutePath = path.resolve(skillRoot, relativePath);
    if (!absolutePath.startsWith(`${skillRoot}${path.sep}`) && absolutePath !== skillRoot) {
      throw new Error(`Invalid skill file path: ${relativePath}.`);
    }
    const content = readFileSync(absolutePath, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (totalBytes > maxSkillReadBytes) {
      throw new Error(`Skill ${safeName} exceeds max read size of ${maxSkillReadBytes} bytes.`);
    }
    return { relativePath, content, bytes };
  });

  return {
    ...metadata,
    path: normalizeRelativePath(path.relative(process.cwd(), skillRoot)),
    entrypoint: normalizeRelativePath(path.relative(process.cwd(), entrypointFile)),
    files,
    totalBytes
  };
}

function listBundledFiles(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
    if (entry.isDirectory()) {
      files.push(...listBundledFiles(root, absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
      continue;
    }
  }
  return files;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export function formatSkillForPrompt(skill: FullSkill): string {
  return skill.files.map((file) => [
    `--- ${file.relativePath} ---`,
    file.content
  ].join("\n")).join("\n\n");
}

export function parseSkillFrontmatter(content: string, skillName: string): SkillMetadata {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new Error(`Invalid skill ${skillName}: missing SKILL.md frontmatter.`);
  }
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    fields.set(field[1], unquoteYamlString(field[2].trim()));
  }
  const name = fields.get("name")?.trim();
  const description = fields.get("description")?.trim();
  if (!name) {
    throw new Error(`Invalid skill ${skillName}: missing frontmatter name.`);
  }
  if (!description) {
    throw new Error(`Invalid skill ${skillName}: missing frontmatter description.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid skill ${skillName}: invalid frontmatter name.`);
  }
  return { name, description };
}

function unquoteYamlString(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
