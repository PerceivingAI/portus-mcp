import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AppResolution =
  | { configured: false }
  | { configured: true; executablePath: string | null };

export type AppDiscoveryConfig = {
  commands: readonly string[];
  aliases: Readonly<Record<string, string>>;
};

export type AppDiscovery = {
  discover(config: AppDiscoveryConfig): Promise<string[]>;
  resolveConfigured(command: string, config: AppDiscoveryConfig): Promise<AppResolution>;
};

type AppDiscoveryDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutableFile?: (candidate: string) => Promise<boolean>;
  queryWindowsAppPath?: (command: string) => Promise<string | null>;
};

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchingKey === undefined ? undefined : env[matchingKey];
}

async function defaultIsExecutableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    await access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}


function parseWindowsAppPath(stdout: string, env: NodeJS.ProcessEnv): string | null {
  const match = stdout.match(/\sREG_(?:EXPAND_)?SZ\s+(.+)\r?$/m);
  if (!match) return null;
  const expanded = match[1].trim().replace(
    /%([^%]+)%/g,
    (token, name: string) => environmentValue(env, name) ?? token
  );
  return expanded.startsWith('"') && expanded.endsWith('"') ? expanded.slice(1, -1) : expanded;
}

function createWindowsAppPathQuery(env: NodeJS.ProcessEnv): (command: string) => Promise<string | null> {
  const systemRoot = environmentValue(env, "SystemRoot") ?? "C:\\Windows";
  const regExecutable = path.win32.join(systemRoot, "System32", "reg.exe");
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths"
  ];

  return async (command: string): Promise<string | null> => {
    for (const root of roots) {
      for (const registryView of ["/reg:64", "/reg:32"]) {
        try {
          const { stdout } = await execFileAsync(
            regExecutable,
            ["query", `${root}\\${command}`, "/ve", registryView],
            { encoding: "utf8", timeout: 2000, windowsHide: true, maxBuffer: 64 * 1024 }
          );
          const resolved = parseWindowsAppPath(stdout, env);
          if (resolved) return resolved;
        } catch {
          // Missing registry keys and unavailable registry views are normal discovery misses.
        }
      }
    }
    return null;
  };
}

function knownWindowsInstallCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const roots = {
    local: environmentValue(env, "LOCALAPPDATA"),
    program: environmentValue(env, "ProgramFiles"),
    programX86: environmentValue(env, "ProgramFiles(x86)")
  };
  const relativeByCommand: Record<string, { root: keyof typeof roots; relative: string }[]> = {
    "chrome.exe": [
      { root: "local", relative: "Google\\Chrome\\Application\\chrome.exe" },
      { root: "program", relative: "Google\\Chrome\\Application\\chrome.exe" },
      { root: "programX86", relative: "Google\\Chrome\\Application\\chrome.exe" }
    ],
    "msedge.exe": [
      { root: "local", relative: "Microsoft\\Edge\\Application\\msedge.exe" },
      { root: "program", relative: "Microsoft\\Edge\\Application\\msedge.exe" },
      { root: "programX86", relative: "Microsoft\\Edge\\Application\\msedge.exe" }
    ],
    "brave.exe": [
      { root: "local", relative: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
      { root: "program", relative: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
      { root: "programX86", relative: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" }
    ],
    "firefox.exe": [
      { root: "local", relative: "Programs\\Mozilla Firefox\\firefox.exe" },
      { root: "program", relative: "Mozilla Firefox\\firefox.exe" },
      { root: "programX86", relative: "Mozilla Firefox\\firefox.exe" }
    ]
  };

  return (relativeByCommand[command.toLowerCase()] ?? []).flatMap(({ root, relative }) => {
    const base = roots[root];
    return base ? [path.win32.join(base, relative)] : [];
  });
}

function pathCandidates(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const pathValue = environmentValue(env, "PATH") ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const directories = pathValue.split(separator).filter(Boolean);
  if (platform !== "win32") {
    return directories.map((directory) => path.posix.join(directory, command));
  }
  if (path.win32.extname(command)) {
    return directories.map((directory) => path.win32.join(directory, command));
  }

  const extensions = (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return directories.flatMap((directory) => extensions.map((extension) => path.win32.join(directory, `${command}${extension.toLowerCase()}`)));
}


export function createAppDiscovery(dependencies: AppDiscoveryDependencies = {}): AppDiscovery {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const isExecutableFile = dependencies.isExecutableFile ?? ((candidate) => defaultIsExecutableFile(candidate, platform));
  const queryWindowsAppPath = dependencies.queryWindowsAppPath ?? createWindowsAppPathQuery(env);
  const platformPath = platform === "win32" ? path.win32 : path.posix;

  function identity(name: string): string {
    return platform === "win32" ? name.toLowerCase() : name;
  }

  async function firstAvailable(candidates: readonly string[], seen: Set<string>): Promise<string | null> {
    for (const candidate of candidates) {
      const candidateIdentity = identity(candidate);
      if (seen.has(candidateIdentity)) continue;
      seen.add(candidateIdentity);
      if (platformPath.isAbsolute(candidate) && await isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  async function resolveCommand(command: string): Promise<string | null> {
    const seen = new Set<string>();
    const fromPath = await firstAvailable(pathCandidates(command, platform, env), seen);
    if (fromPath || platform !== "win32") return fromPath;

    const registeredPath = await queryWindowsAppPath(command);
    const fromRegistry = registeredPath ? await firstAvailable([registeredPath], seen) : null;
    if (fromRegistry) return fromRegistry;

    return firstAvailable(knownWindowsInstallCandidates(command, env), seen);
  }

  async function resolveAlias(executablePath: string): Promise<string | null> {
    if (!platformPath.isAbsolute(executablePath)) return null;
    return await isExecutableFile(executablePath) ? executablePath : null;
  }

  return {
    async discover(config) {
      const aliases = Object.entries(config.aliases);
      const aliasByIdentity = new Map<string, { name: string; executablePath: string }>();
      for (const [name, executablePath] of aliases) {
        const aliasIdentity = identity(name);
        if (!aliasByIdentity.has(aliasIdentity)) {
          aliasByIdentity.set(aliasIdentity, { name, executablePath });
        }
      }
      const visitedAliases = new Set<string>();
      const emitted = new Set<string>();
      const apps: string[] = [];

      for (const command of config.commands) {
        const commandIdentity = identity(command);
        if (emitted.has(commandIdentity)) continue;
        const alias = aliasByIdentity.get(commandIdentity);
        if (alias) {
          visitedAliases.add(commandIdentity);
          if (await resolveAlias(alias.executablePath)) {
            apps.push(alias.name);
            emitted.add(commandIdentity);
          }
          continue;
        }
        if (await resolveCommand(command)) {
          apps.push(command);
          emitted.add(commandIdentity);
        }
      }

      for (const [name, executablePath] of aliases) {
        const aliasIdentity = identity(name);
        if (visitedAliases.has(aliasIdentity) || emitted.has(aliasIdentity)) continue;
        if (await resolveAlias(executablePath)) {
          apps.push(name);
          emitted.add(aliasIdentity);
        }
      }
      return apps;
    },

    async resolveConfigured(command, config) {
      const commandIdentity = identity(command);
      const configuredAlias = Object.entries(config.aliases).find(([name]) => identity(name) === commandIdentity);
      if (configuredAlias) {
        return { configured: true, executablePath: await resolveAlias(configuredAlias[1]) };
      }
      const configuredCommand = config.commands.find((candidate) => identity(candidate) === commandIdentity);
      if (!configuredCommand) return { configured: false };
      return { configured: true, executablePath: await resolveCommand(configuredCommand) };
    }
  };
}
