import path from "node:path";
import { loadConfig } from "../config.js";
import { getProject } from "../state/ProjectRegistry.js";

export function resolveProjectPath(projectAlias: string, relativePath = "."): string {
  const project = getProject(projectAlias);
  const root = path.resolve(project.rootPath);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }

  const config = loadConfig();
  const normalizedTarget = target.toLowerCase();
  for (const blocked of config.blockedPathPatterns) {
    if (normalizedTarget.includes(blocked.toLowerCase())) {
      throw new Error(`Blocked path pattern '${blocked}' matched ${target}`);
    }
  }

  return target;
}
