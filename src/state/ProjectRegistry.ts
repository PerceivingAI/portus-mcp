import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { stateStore } from "./StateStore.js";
import { optionalEnv } from "../env.js";

export type ProjectRecord = {
  projectAlias: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
};

type ProjectState = {
  projects: ProjectRecord[];
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

const FILE = "projects.json";

export function listProjects(): ProjectRecord[] {
  const stateProjects = stateStore.readJson<ProjectState>(FILE, { projects: [] }).projects;
  const preRegistered = listPreRegisteredProjects();
  const byAlias = new Map<string, ProjectRecord>();
  for (const project of preRegistered) byAlias.set(project.projectAlias, project);
  for (const project of stateProjects) byAlias.set(project.projectAlias, project);
  return Array.from(byAlias.values());
}

export function getProject(projectAlias: string): ProjectRecord {
  const project = listProjects().find((item) => item.projectAlias === projectAlias);
  if (!project) throw new Error(`Unknown project alias: ${projectAlias}`);
  return project;
}

export function upsertProject(input: Omit<ProjectRecord, "createdAt" | "updatedAt">): ProjectRecord {
  const state = stateStore.readJson<ProjectState>(FILE, { projects: [] });
  const existing = state.projects.find((item) => item.projectAlias === input.projectAlias);
  const now = new Date().toISOString();
  const record: ProjectRecord = {
    ...input,
    rootPath: normalizeProjectRoot(input.rootPath),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  state.projects = state.projects.filter((item) => item.projectAlias !== input.projectAlias);
  state.projects.push(record);
  stateStore.writeJson(FILE, state);
  return record;
}

export function listPreRegisteredProjects(): ProjectRecord[] {
  const raw = optionalEnv("PORTUS_MCP_PROJECTS", "").trim();
  if (!raw) return [];
  const now = new Date().toISOString();
  return raw.split(";").map((entry) => {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error("Invalid PORTUS_MCP_PROJECTS entry. Use alias=/absolute/path;other=/absolute/path.");
    }
    const projectAlias = trimmed.slice(0, separator).trim();
    const rootPath = trimmed.slice(separator + 1).trim();
    if (!projectAlias || !rootPath) {
      throw new Error("Invalid PORTUS_MCP_PROJECTS entry. Project alias and path are required.");
    }
    return {
      projectAlias,
      rootPath: normalizeProjectRoot(rootPath),
      createdAt: now,
      updatedAt: now
    };
  });
}

