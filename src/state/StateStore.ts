import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { optionalEnv } from "../env.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";

export class StateStore {
  get root(): string {
    const dir = path.resolve(optionalEnv("PORTUS_MCP_STATE_DIR", ".portus-mcp"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  path(name: string): string {
    return path.join(this.root, name);
  }

  readJson<T>(name: string, fallback: T): T {
    const file = this.path(name);
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  writeJson<T>(name: string, value: T): void {
    writeFileSync(this.path(name), JSON.stringify(value, null, 2) + "\n", "utf8");
  }

  audit(event: Record<string, unknown>): void {
    appendFileSync(this.path("audit.log"), JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event
    }) + "\n", "utf8");
  }

  requireAuditWritable(): void {
    if (!isAuditStrictMode()) return;
    const auditPath = this.path("audit.log");
    if (existsSync(auditPath) && !statSync(auditPath).isFile()) {
      throw new Error(`Audit log is not writable: ${auditPath}`);
    }
    const fd = openSync(auditPath, "a");
    closeSync(fd);
  }

  readAudit(limit = 100): Array<Record<string, unknown>> {
    const file = this.path("audit.log");
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { parseError: true, raw: line };
      }
    });
  }
}

export const stateStore = new StateStore();

function isAuditStrictMode(): boolean {
  return loadPolicyConfig().audit.strictMode;
}

