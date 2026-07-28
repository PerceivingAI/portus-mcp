import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "portus-flue-check-"));
try {
  const agentsDir = path.join(tempDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  copyFileSync(
    path.join(process.cwd(), "subagents", "ephemeral-project-subagent.ts"),
    path.join(agentsDir, "ephemeral-project-subagent.ts")
  );

  const rootNodeModules = path.join(process.cwd(), "node_modules");
  const tempNodeModules = path.join(tempDir, "node_modules");
  if (existsSync(rootNodeModules)) {
    symlinkSync(rootNodeModules, tempNodeModules, process.platform === "win32" ? "junction" : "dir");
  }

  const flueCli = path.resolve(process.cwd(), "node_modules", "@flue", "cli", "dist", "flue.js");
  const outputDir = path.join(tempDir, "dist");

  execFileSync(process.execPath, [flueCli, "build", "--target", "node", "--workspace", tempDir, "--output", outputDir], {
    stdio: "inherit"
  });
  console.log("Flue check succeeded.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
