import path from "node:path";
import { loadPolicyConfig } from "./policyConfig.js";
import { getProject } from "../state/ProjectRegistry.js";

export function resolveProjectPath(projectAlias: string, relativePath = "."): string {
  const project = getProject(projectAlias);
  const root = path.resolve(project.rootPath);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }

  const policy = loadPolicyConfig();
  const normalizedTarget = target.toLowerCase();
  for (const blocked of policy.pathPolicy.blockedPatterns) {
    if (normalizedTarget.includes(blocked.toLowerCase())) {
      throw new Error(`Blocked path pattern '${blocked}' matched ${target}`);
    }
  }

  return target;
}
