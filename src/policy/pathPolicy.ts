import path from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { loadPolicyConfig } from "./policyConfig.js";
import { getProject } from "../state/ProjectRegistry.js";
import type { SkillRegistrySnapshot } from "../skills/SkillRegistry.js";

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertNotBlocked(target: string): void {
  const normalizedTarget = target.toLowerCase();
  for (const blocked of loadPolicyConfig().pathPolicy.blockedPatterns) {
    if (normalizedTarget.includes(blocked.toLowerCase())) {
      throw new Error("Blocked path pattern.");
    }
  }
}

function assertCanonicalRootPath(root: string, target: string, rootKind: "project" | "skill"): void {
  const rootLabel = rootKind === "project" ? "Project" : "Skill";
  try {
    if (!statSync(root).isDirectory()) {
      throw new Error(`${rootLabel} root cannot be resolved safely.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${rootLabel} root cannot be resolved safely.`) throw error;
    throw new Error(`${rootLabel} root cannot be resolved safely.`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    throw new Error(`${rootLabel} root cannot be resolved safely.`);
  }

  const relativeTarget = path.relative(root, target);
  const segments = relativeTarget === "" ? [] : relativeTarget.split(path.sep).filter(Boolean);
  let current = root;
  let nearestExisting = root;
  let missing = false;

  for (const segment of segments) {
    current = path.join(current, segment);
    if (missing) continue;
    try {
      lstatSync(current);
      nearestExisting = current;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") throw new Error(`${rootLabel} path cannot be resolved safely.`);
      missing = true;
    }
  }

  let canonicalExisting: string;
  try {
    canonicalExisting = realpathSync.native(nearestExisting);
  } catch {
    throw new Error(`${rootLabel} path cannot be resolved safely.`);
  }
  if (!isContained(canonicalRoot, canonicalExisting)) {
    throw new Error(`Path escapes ${rootKind} root.`);
  }

  const unresolvedSuffix = path.relative(nearestExisting, target);
  const canonicalTarget = path.resolve(canonicalExisting, unresolvedSuffix);
  if (!isContained(canonicalRoot, canonicalTarget)) {
    throw new Error(`Path escapes ${rootKind} root.`);
  }
  assertNotBlocked(canonicalTarget);
}

export function resolveProjectPath(projectAlias: string, relativePath = "."): string {
  const project = getProject(projectAlias);
  const root = path.resolve(project.rootPath);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes project root.");
  }

  assertNotBlocked(target);
  assertCanonicalRootPath(root, target, "project");

  return target;
}

export function resolveReadablePath(rootAlias: string, relativePath: string, registry: SkillRegistrySnapshot): string {
  const skill = registry.connected.byAlias.get(rootAlias);
  if (!skill) return resolveProjectPath(rootAlias, relativePath);

  const root = path.resolve(skill.rootPath);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes skill root.");
  }
  assertNotBlocked(target);
  assertCanonicalRootPath(root, target, "skill");
  return target;
}
