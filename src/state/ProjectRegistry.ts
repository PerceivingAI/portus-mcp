import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { optionalEnv } from "../env.js";

export type ProjectRecord = {
  projectAlias: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
};

function normalizeProjectRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  let canonical: string;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    throw new Error("Project root must be an existing directory.");
  }
  try {
    if (!lstatSync(canonical).isDirectory()) throw new Error("Project root must be an existing directory.");
  } catch (error) {
    if (error instanceof Error && error.message === "Project root must be an existing directory.") throw error;
    throw new Error("Project root cannot be resolved safely.");
  }
  return canonical;
}

export function assertProjectAlias(projectAlias: string): void {
  if (projectAlias.trim() === "") throw new Error("Project alias is required.");
  if (projectAlias.startsWith("skill/")) {
    throw new Error("Project aliases beginning with skill/ are reserved for configured read-only skills.");
  }
}

export function listProjects(): ProjectRecord[] {
  const raw = optionalEnv("PORTUS_MCP_PROJECTS", "").trim();
  if (!raw) return [];
  const now = new Date().toISOString();
  const entries = raw
    .split(/[\r\n;|]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"));

  const byAlias = new Map<string, ProjectRecord>();
  for (const trimmed of entries) {
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error("Invalid PORTUS_MCP_PROJECTS entry. Use alias=/absolute/path.");
    }
    const projectAlias = trimmed.slice(0, separator).trim();
    assertProjectAlias(projectAlias);
    const rootPath = trimmed.slice(separator + 1).trim();
    if (!projectAlias || !rootPath) {
      throw new Error("Invalid PORTUS_MCP_PROJECTS entry. Project alias and path are required.");
    }
    byAlias.set(projectAlias, {
      projectAlias,
      rootPath: normalizeProjectRoot(rootPath),
      createdAt: now,
      updatedAt: now
    });
  }
  return Array.from(byAlias.values());
}

export function getProject(projectAlias: string): ProjectRecord {
  const project = listProjects().find((item) => item.projectAlias === projectAlias);
  if (!project) throw new Error(`Unknown project alias: ${projectAlias}`);
  return project;
}

export function listPreRegisteredProjects(): ProjectRecord[] {
  return listProjects();
}

