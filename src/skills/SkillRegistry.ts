import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { countChars } from "../runtime/outputLimits.js";

const SKILL_ALIAS_PREFIX = "skill/";
const SKILL_ENTRYPOINT = "SKILL.md";
const OPENAI_METADATA_PATH = path.join("agents", "openai.yaml");

const skillNamePattern = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;

const frontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string()).optional(),
  "allowed-tools": z.string().min(1).optional()
}).passthrough();

const openAiMetadataSchema = z.object({
  interface: z.object({
    display_name: z.string().min(1).optional(),
    short_description: z.string().min(1).optional(),
    icon_small: z.string().min(1).optional(),
    icon_large: z.string().min(1).optional(),
    brand_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    default_prompt: z.string().min(1).optional()
  }).strict().optional(),
  policy: z.object({
    allow_implicit_invocation: z.boolean().optional()
  }).strict().optional(),
  dependencies: z.object({
    tools: z.array(z.object({
      type: z.literal("mcp"),
      value: z.string().min(1),
      description: z.string().min(1).optional(),
      transport: z.string().min(1).optional(),
      url: z.string().url().optional()
    }).strict()).optional()
  }).strict().optional()
}).strict();

export type SkillFrontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
};

export type OpenAiSkillMetadata = z.infer<typeof openAiMetadataSchema>;

export type SkillDefinition = SkillFrontmatter & {
  rootAlias: string;
  rootPath: string;
  entrypoint: typeof SKILL_ENTRYPOINT;
  allowImplicitInvocation: boolean;
  openai?: OpenAiSkillMetadata;
};

export type SkillCatalogEntry = Omit<SkillDefinition, "rootPath" | "openai"> & {
  interface?: OpenAiSkillMetadata["interface"];
  dependencies?: OpenAiSkillMetadata["dependencies"];
};

export type SkillAudienceRegistry = {
  audience: "connected" | "subagent";
  skills: readonly SkillDefinition[];
  catalog: readonly SkillCatalogEntry[];
  byName: ReadonlyMap<string, SkillDefinition>;
  byAlias: ReadonlyMap<string, SkillDefinition>;
};

export type SkillRegistrySnapshot = {
  connected: SkillAudienceRegistry;
  subagents: SkillAudienceRegistry;
};

function yamlValue(source: string, label: string): unknown {
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid ${label} YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  try {
    return document.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw new Error(`Invalid ${label} YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractFrontmatter(content: string, skillName: string): string {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) throw new Error(`Invalid skill ${skillName}: missing SKILL.md frontmatter.`);
  return match[1];
}

export function parseSkillFrontmatter(content: string, skillName: string): SkillFrontmatter {
  const parsed = frontmatterSchema.safeParse(yamlValue(extractFrontmatter(content, skillName), `skill ${skillName} frontmatter`));
  if (!parsed.success) {
    throw new Error(`Invalid skill ${skillName} frontmatter: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`).join("; ")}`);
  }

  const name = parsed.data.name.trim();
  const description = parsed.data.description.trim();
  if (!skillNamePattern.test(name)) throw new Error(`Invalid skill ${skillName}: invalid frontmatter name.`);
  if (name !== skillName) throw new Error(`Invalid skill ${skillName}: frontmatter name must match folder name.`);
  if (countChars(description) < 1) throw new Error(`Invalid skill ${skillName}: missing frontmatter description.`);
  if (countChars(description) > 1024) throw new Error(`Invalid skill ${skillName}: frontmatter description exceeds 1024 characters.`);

  return {
    name,
    description,
    ...(parsed.data.license === undefined ? {} : { license: parsed.data.license }),
    ...(parsed.data.compatibility === undefined ? {} : { compatibility: parsed.data.compatibility }),
    ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    ...(parsed.data["allowed-tools"] === undefined ? {} : { allowedTools: parsed.data["allowed-tools"] })
  };
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalDirectory(inputPath: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(inputPath);
    if (!lstatSync(canonical).isDirectory()) throw new Error();
  } catch {
    throw new Error(`${label} must be an existing directory.`);
  }
  return canonical;
}

function readBoundedTextFile(filePath: string, label: string): string {
  const maxChars = loadPolicyConfig().limits.skills.maxReadChars;
  let info;
  try {
    info = statSync(filePath);
  } catch {
    throw new Error(`${label} does not exist.`);
  }
  if (!info.isFile()) throw new Error(`${label} must be a regular file.`);
  if (info.size > maxChars * 4) throw new Error(`${label} exceeds the configured skill read limit.`);
  const content = readFileSync(filePath, "utf8");
  if (countChars(content) > maxChars) throw new Error(`${label} exceeds the configured skill read limit.`);
  return content;
}

function canonicalSkillFile(skillRoot: string, relativePath: string, label: string): string {
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`${label} must use a relative path.`);
  }
  const target = path.resolve(skillRoot, relativePath);
  if (!isContained(skillRoot, target)) throw new Error(`${label} escapes the skill root.`);
  let canonical: string;
  try {
    canonical = realpathSync.native(target);
  } catch {
    throw new Error(`${label} does not exist.`);
  }
  if (!isContained(skillRoot, canonical)) throw new Error(`${label} escapes the skill root.`);
  return canonical;
}

function loadOpenAiMetadata(skillRoot: string, skillName: string): OpenAiSkillMetadata | undefined {
  const metadataPath = path.join(skillRoot, OPENAI_METADATA_PATH);
  if (!existsSync(metadataPath)) return undefined;
  const canonicalPath = canonicalSkillFile(skillRoot, OPENAI_METADATA_PATH, `Skill ${skillName} agents/openai.yaml`);
  const parsed = openAiMetadataSchema.safeParse(yamlValue(readBoundedTextFile(canonicalPath, `Skill ${skillName} agents/openai.yaml`), `skill ${skillName} agents/openai.yaml`));
  if (!parsed.success) {
    throw new Error(`Invalid skill ${skillName} agents/openai.yaml: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  for (const iconPath of [parsed.data.interface?.icon_small, parsed.data.interface?.icon_large]) {
    if (iconPath !== undefined) canonicalSkillFile(skillRoot, iconPath, `Skill ${skillName} icon`);
  }
  return parsed.data;
}

function loadSkill(skillPath: string): SkillDefinition {
  const rootPath = canonicalDirectory(skillPath, "Skill path");
  const skillName = path.basename(rootPath);
  if (!skillNamePattern.test(skillName)) throw new Error(`Invalid skill directory name: ${skillName}.`);
  const entrypointPath = canonicalSkillFile(rootPath, SKILL_ENTRYPOINT, `Skill ${skillName} SKILL.md`);
  const frontmatter = parseSkillFrontmatter(readBoundedTextFile(entrypointPath, `Skill ${skillName} SKILL.md`), skillName);
  const openai = loadOpenAiMetadata(rootPath, skillName);
  return {
    ...frontmatter,
    rootAlias: `${SKILL_ALIAS_PREFIX}${frontmatter.name}`,
    rootPath,
    entrypoint: SKILL_ENTRYPOINT,
    allowImplicitInvocation: openai?.policy?.allow_implicit_invocation ?? true,
    ...(openai === undefined ? {} : { openai })
  };
}

function configuredSourcePaths(variableName: string, baseDirectory: string): string[] {
  const raw = process.env[variableName];
  if (raw === undefined) {
    const defaultPath = path.resolve(baseDirectory, "skills");
    return existsSync(defaultPath) ? [defaultPath] : [];
  }
  if (raw.trim() === "") return [];
  const entries = raw.split(";").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) throw new Error(`${variableName} contains an empty path entry.`);
  return entries.map((entry) => path.resolve(baseDirectory, entry));
}

function discoverSource(sourcePath: string, variableName: string): SkillDefinition[] {
  const canonicalSource = canonicalDirectory(sourcePath, `${variableName} entry`);
  if (existsSync(path.join(canonicalSource, SKILL_ENTRYPOINT))) return [loadSkill(canonicalSource)];

  const skills: SkillDefinition[] = [];
  for (const entry of readdirSync(canonicalSource, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const childPath = path.join(canonicalSource, entry.name);
    if (!existsSync(path.join(childPath, SKILL_ENTRYPOINT))) continue;
    skills.push(loadSkill(childPath));
  }
  return skills;
}

function toCatalogEntry(skill: SkillDefinition): SkillCatalogEntry {
  return {
    name: skill.name,
    description: skill.description,
    rootAlias: skill.rootAlias,
    entrypoint: skill.entrypoint,
    allowImplicitInvocation: skill.allowImplicitInvocation,
    ...(skill.license === undefined ? {} : { license: skill.license }),
    ...(skill.compatibility === undefined ? {} : { compatibility: skill.compatibility }),
    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
    ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
    ...(skill.openai?.interface === undefined ? {} : { interface: skill.openai.interface }),
    ...(skill.openai?.dependencies === undefined ? {} : { dependencies: skill.openai.dependencies })
  };
}

function buildAudienceRegistry(audience: SkillAudienceRegistry["audience"], variableName: string, baseDirectory: string): SkillAudienceRegistry {
  const byCanonicalRoot = new Map<string, SkillDefinition>();
  for (const sourcePath of configuredSourcePaths(variableName, baseDirectory)) {
    for (const skill of discoverSource(sourcePath, variableName)) {
      if (!byCanonicalRoot.has(skill.rootPath)) byCanonicalRoot.set(skill.rootPath, skill);
    }
  }

  const skills = [...byCanonicalRoot.values()].sort((left, right) => left.name.localeCompare(right.name));
  const byName = new Map<string, SkillDefinition>();
  const byAlias = new Map<string, SkillDefinition>();
  for (const skill of skills) {
    const existing = byName.get(skill.name);
    if (existing && existing.rootPath !== skill.rootPath) {
      throw new Error(`Duplicate ${audience} skill name resolves to different directories: ${skill.name}.`);
    }
    byName.set(skill.name, skill);
    byAlias.set(skill.rootAlias, skill);
  }

  return Object.freeze({
    audience,
    skills: Object.freeze(skills),
    catalog: Object.freeze(skills.map(toCatalogEntry)),
    byName,
    byAlias
  });
}

export function loadSkillRegistry(): SkillRegistrySnapshot {
  const configPath = path.resolve(process.env.PORTUS_MCP_CONFIG_PATH?.trim() || "./portus-mcp.config.json");
  const baseDirectory = path.dirname(configPath);
  return Object.freeze({
    connected: buildAudienceRegistry("connected", "AGENT_SKILL_PATHS", baseDirectory),
    subagents: buildAudienceRegistry("subagent", "SUBAGENTS_SKILL_PATHS", baseDirectory)
  });
}

export function connectedSkillForAlias(registry: SkillRegistrySnapshot, rootAlias: string): SkillDefinition | undefined {
  return registry.connected.byAlias.get(rootAlias);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function connectedSkillInstructions(registry: SkillRegistrySnapshot): string {
  if (registry.connected.catalog.length === 0) return "Portus connected-agent skills are disabled for this instance.";
  const catalog = registry.connected.catalog.map((skill) => {
    const dependencies = skill.dependencies?.tools?.map((dependency) => `<dependency type="${escapeXml(dependency.type)}" value="${escapeXml(dependency.value)}" />`).join("") ?? "";
    return `<skill name="${escapeXml(skill.name)}" root-alias="${escapeXml(skill.rootAlias)}" entrypoint="${escapeXml(skill.entrypoint)}" implicit-invocation="${String(skill.allowImplicitInvocation)}"><description>${escapeXml(skill.description)}</description>${dependencies}</skill>`;
  }).join("");
  const instructions = [
    "Portus provides the following configured read-only skills.",
    "Select a skill yourself when its description matches the task. For implicit-invocation=false, use it only when the user explicitly names it.",
    "Read a selected skill with the existing project_read tool: set projectAlias to its root-alias and read SKILL.md. Read referenced files only when needed. Use ordinary permitted tools for the task and for skill scripts.",
    "Never treat agents/openai.yaml as skill instructions. Never infer or scan unlisted host skill locations.",
    `<available_skills>${catalog}</available_skills>`
  ].join("\n");
  const limit = loadPolicyConfig().limits.skills.maxReadChars;
  if (countChars(instructions) > limit) throw new Error(`Connected-agent skill catalog exceeds the configured skill read limit of ${limit} characters.`);
  return instructions;
}
