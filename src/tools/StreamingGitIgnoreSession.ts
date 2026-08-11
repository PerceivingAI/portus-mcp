import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

const RESPONSE_FIELD_COUNT = 4;
const MAX_PENDING_FIELD_BYTES = 16 * 1024 * 1024;
const MAX_STDIN_CHUNK_BYTES = 64 * 1024;
const CLOSE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 2_000;

export type StreamingGitIgnoreSessionOptions = {
  command?: string;
  argsPrefix?: readonly string[];
  env?: NodeJS.ProcessEnv;
};

type PendingQuery = {
  relativePath: string;
  resolve: (ignored: boolean) => void;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function normalizeRelativePath(relativePath: string): string | null {
  if (relativePath.includes("\0")) throw new Error("Git-ignore paths must not contain NUL bytes");

  const platformNormalized = path.sep === "\\" ? relativePath.replace(/\\/g, "/") : relativePath;
  if (path.posix.isAbsolute(platformNormalized) || path.win32.isAbsolute(platformNormalized)) {
    throw new Error("Git-ignore paths must be project-relative");
  }

  const normalized = path.posix.normalize(platformNormalized);
  if (normalized === ".") return null;
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Git-ignore paths must remain inside the project root");
  }
  return normalized;
}

export class StreamingGitIgnoreSession {
  private readonly cache = new Map<string, boolean>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly pendingQueries: PendingQuery[] = [];
  private readonly command: string;
  private readonly argsPrefix: readonly string[];
  private readonly env: NodeJS.ProcessEnv;

  private child: ChildProcessWithoutNullStreams | null = null;
  private processClosePromise: Promise<void> | null = null;
  private resolveProcessClose: (() => void) | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private responseFields: string[] = [];
  private responseRemainder = Buffer.alloc(0);
  private unavailable = false;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private spawnedCount = 0;

  constructor(private readonly projectRoot: string, options: StreamingGitIgnoreSessionOptions = {}) {
    this.command = options.command ?? "git";
    this.argsPrefix = options.argsPrefix ?? [];
    this.env = { ...process.env, ...options.env, GIT_FLUSH: "1" };
  }

  get gitProcessesSpawned(): number {
    return this.spawnedCount;
  }

  isIgnoredCached(relativePath: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
    if (normalized === null) return false;
    return this.cachedDecision(normalized) === true;
  }

  async check(relativePaths: readonly string[]): Promise<ReadonlySet<string>> {
    if (this.closing || this.closed) throw new Error("Git-ignore session is closed");

    const normalizedPaths = relativePaths.map(normalizeRelativePath);
    const decisions = new Map<string, Promise<boolean>>();
    const pathsToWrite: string[] = [];

    for (const relativePath of normalizedPaths) {
      if (relativePath === null || decisions.has(relativePath)) continue;

      const cached = this.cachedDecision(relativePath);
      if (cached !== undefined) {
        decisions.set(relativePath, Promise.resolve(cached));
        continue;
      }

      const existing = this.inFlight.get(relativePath);
      if (existing) {
        decisions.set(relativePath, existing);
        continue;
      }

      if (this.unavailable) {
        this.cache.set(relativePath, false);
        decisions.set(relativePath, Promise.resolve(false));
        continue;
      }

      let resolveDecision!: (ignored: boolean) => void;
      const decision = new Promise<boolean>((resolve) => {
        resolveDecision = resolve;
      });
      this.inFlight.set(relativePath, decision);
      this.pendingQueries.push({ relativePath, resolve: resolveDecision });
      decisions.set(relativePath, decision);
      pathsToWrite.push(relativePath);
    }

    if (pathsToWrite.length > 0) {
      if (this.ensureProcess()) {
        this.writeChain = this.writeChain
          .then(() => this.writePaths(pathsToWrite))
          .catch(() => this.makeUnavailable());
      } else {
        this.makeUnavailable();
      }
    }

    const resolved = new Map<string, boolean>();
    await Promise.all(Array.from(decisions, async ([relativePath, decision]) => {
      resolved.set(relativePath, await decision);
    }));

    const ignored = new Set<string>();
    for (const relativePath of normalizedPaths) {
      if (relativePath !== null && resolved.get(relativePath) === true) ignored.add(relativePath);
    }
    return ignored;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeProcess();
    return this.closePromise;
  }

  private cachedDecision(relativePath: string): boolean | undefined {
    const exact = this.cache.get(relativePath);
    if (exact !== undefined) return exact;

    const parts = relativePath.split("/");
    let ancestor = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      ancestor = ancestor ? `${ancestor}/${parts[index]}` : parts[index];
      if (this.cache.get(ancestor) === true) {
        this.cache.set(relativePath, true);
        return true;
      }
    }
    return undefined;
  }

  private ensureProcess(): boolean {
    if (this.child) return !this.unavailable;
    if (this.unavailable || this.closing || this.closed) return false;

    try {
      this.spawnedCount += 1;
      const child = spawn(this.command, [
        ...this.argsPrefix,
        "check-ignore",
        "--stdin",
        "--verbose",
        "--non-matching",
        "-z"
      ], {
        cwd: this.projectRoot,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      this.child = child;
      this.processClosePromise = new Promise((resolve) => {
        this.resolveProcessClose = resolve;
      });

      child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
      child.stdout.on("error", () => this.makeUnavailable());
      child.stdin.on("error", () => this.makeUnavailable());
      child.stderr.on("data", () => undefined);
      child.stderr.on("error", () => this.makeUnavailable());
      child.once("error", () => this.makeUnavailable());
      child.once("close", () => this.handleProcessClose());
      return true;
    } catch {
      this.makeUnavailable();
      return false;
    }
  }

  private async writePaths(relativePaths: readonly string[]): Promise<void> {
    let records: string[] = [];
    let chunkBytes = 0;

    const flush = async (): Promise<void> => {
      if (records.length === 0) return;
      const chunk = records.join("");
      records = [];
      chunkBytes = 0;
      await this.writeChunk(chunk);
    };

    for (const relativePath of relativePaths) {
      const record = `${relativePath}\0`;
      const recordBytes = Buffer.byteLength(record);
      if (records.length > 0 && chunkBytes + recordBytes > MAX_STDIN_CHUNK_BYTES) await flush();
      records.push(record);
      chunkBytes += recordBytes;
      if (chunkBytes >= MAX_STDIN_CHUNK_BYTES) await flush();
    }
    await flush();
  }

  private async writeChunk(chunk: string): Promise<void> {
    const child = this.child;
    if (!child || this.unavailable || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("Git-ignore process is unavailable");
    }
    if (child.stdin.write(chunk, "utf8")) return;

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.stdin.off("drain", onDrain);
        child.stdin.off("error", onError);
        child.stdin.off("close", onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("Git-ignore stdin failed"));
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("Git-ignore stdin closed"));
      };
      child.stdin.once("drain", onDrain);
      child.stdin.once("error", onError);
      child.stdin.once("close", onClose);
    });
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.unavailable) return;
    const data = this.responseRemainder.length === 0
      ? chunk
      : Buffer.concat([this.responseRemainder, chunk]);
    let fieldStart = 0;

    while (fieldStart < data.length) {
      const fieldEnd = data.indexOf(0, fieldStart);
      if (fieldEnd === -1) break;
      if (fieldEnd - fieldStart > MAX_PENDING_FIELD_BYTES) {
        this.makeUnavailable();
        return;
      }
      this.responseFields.push(data.toString("utf8", fieldStart, fieldEnd));
      fieldStart = fieldEnd + 1;
      if (this.responseFields.length === RESPONSE_FIELD_COUNT) {
        const [source, line, pattern, responsePath] = this.responseFields;
        this.responseFields = [];
        if (!this.settleResponse(source, line, pattern, responsePath)) return;
      }
    }

    this.responseRemainder = Buffer.from(data.subarray(fieldStart));
    if (this.responseRemainder.length > MAX_PENDING_FIELD_BYTES) this.makeUnavailable();
  }

  private settleResponse(source: string, line: string, pattern: string, responsePath: string): boolean {
    const pending = this.pendingQueries[0];
    const nonMatch = source === "" && line === "" && pattern === "";
    const match = source !== "" && /^\d+$/.test(line) && pattern !== "";
    if (!pending || pending.relativePath !== responsePath || (!nonMatch && !match)) {
      this.makeUnavailable();
      return false;
    }

    this.pendingQueries.shift();
    const ignored = match && !pattern.startsWith("!");
    this.cache.set(pending.relativePath, ignored);
    this.inFlight.delete(pending.relativePath);
    pending.resolve(ignored);
    return true;
  }

  private handleProcessClose(): void {
    this.resolveProcessClose?.();
    this.resolveProcessClose = null;
    if (this.pendingQueries.length > 0 || this.responseFields.length > 0 || this.responseRemainder.length > 0) {
      this.makeUnavailable();
    } else if (!this.closing) {
      this.unavailable = true;
    }
  }

  private makeUnavailable(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.responseFields = [];
    this.responseRemainder = Buffer.alloc(0);

    while (this.pendingQueries.length > 0) {
      const pending = this.pendingQueries.shift()!;
      this.cache.set(pending.relativePath, false);
      this.inFlight.delete(pending.relativePath);
      pending.resolve(false);
    }

    const child = this.child;
    if (!child) return;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }

  private async closeProcess(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.closed = true;
      return;
    }

    await this.writeChain;
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end();

    const processClosed = this.processClosePromise ?? Promise.resolve();
    const graceful = await Promise.race([
      processClosed.then(() => true),
      delay(CLOSE_GRACE_MS).then(() => false)
    ]);
    if (!graceful && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (!graceful) await Promise.race([processClosed, delay(KILL_GRACE_MS)]);

    this.closed = true;
  }
}
