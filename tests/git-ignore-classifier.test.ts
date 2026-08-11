import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StreamingGitIgnoreSession } from "../src/tools/StreamingGitIgnoreSession.js";

function temporaryRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function initializeRepository(root: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "portus-test@example.invalid"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Portus Test"], { cwd: root, stdio: "ignore" });
}

function writeFakeGit(root: string): string {
  const script = path.join(root, "fake-git.mjs");
  writeFileSync(script, `
let pending = Buffer.alloc(0);
const mode = process.env.PORTUS_FAKE_GIT_MODE ?? "normal";
process.stdin.on("data", (chunk) => {
  if (mode === "fatal") process.exit(2);
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const end = pending.indexOf(0);
    if (end === -1) break;
    const relativePath = pending.toString("utf8", 0, end);
    pending = pending.subarray(end + 1);
    if (mode === "malformed") {
      process.stdout.write(Buffer.from("\\0\\0\\0wrong-path\\0"));
      continue;
    }
    const fields = relativePath.includes("ignored")
      ? [".gitignore", "1", "ignored*", relativePath]
      : relativePath.includes("negated")
        ? [".gitignore", "2", "!negated*", relativePath]
        : ["", "", "", relativePath];
    const record = Buffer.from(fields.join("\\0") + "\\0");
    const split = Math.max(1, Math.floor(record.length / 2));
    process.stdout.write(record.subarray(0, split));
    process.stdout.write(record.subarray(split));
  }
});
`, "utf8");
  return script;
}

test("streaming Git classifier preserves native ignore semantics with one process", async (t) => {
  const root = temporaryRoot("portus-git-ignore-real-");
  initializeRepository(root);

  mkdirSync(path.join(root, "ignored"));
  mkdirSync(path.join(root, "nested"));
  writeFileSync(path.join(root, "tracked.log"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.log"], { cwd: root, stdio: "ignore" });
  writeFileSync(path.join(root, ".gitignore"), [
    "ignored/",
    "*.log",
    "!important.log",
    "space name.txt",
    "unicodé.txt",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(root, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n", "utf8");
  writeFileSync(path.join(root, ".git", "info", "exclude"), "info-only.txt\n", "utf8");
  const globalExcludes = path.join(root, "global-excludes");
  writeFileSync(globalExcludes, "global-only.txt\n", "utf8");

  const session = new StreamingGitIgnoreSession(root, {
    argsPrefix: ["-c", `core.excludesFile=${globalExcludes}`]
  });
  t.after(async () => {
    await session.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const first = await session.check([
    "ignored",
    "ignored/file.txt",
    "plain.txt",
    "debug.log",
    "important.log",
    "tracked.log",
    "nested/drop.tmp",
    "nested/keep.tmp"
  ]);
  assert.deepEqual([...first], ["ignored", "ignored/file.txt", "debug.log", "nested/drop.tmp"]);

  const second = await session.check([
    "info-only.txt",
    "global-only.txt",
    "space name.txt",
    "unicodé.txt",
    "plain.txt"
  ]);
  assert.deepEqual([...second], ["info-only.txt", "global-only.txt", "space name.txt", "unicodé.txt"]);
  assert.equal(session.isIgnoredCached("ignored/descendant.txt"), true);
  assert.equal(session.gitProcessesSpawned, 1);

  await session.close();
  await session.close();
});

test("streaming Git classifier parses partial records and handles large incremental input", async (t) => {
  const root = temporaryRoot("portus-git-ignore-fake-");
  const fakeGit = writeFakeGit(root);
  const session = new StreamingGitIgnoreSession(root, {
    command: process.execPath,
    argsPrefix: [fakeGit]
  });
  t.after(async () => {
    await session.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const first = await session.check(["ignored.txt", "negated.txt", "plain.txt", "line\nbreak.txt"]);
  assert.deepEqual([...first], ["ignored.txt"]);

  const paths = Array.from({ length: 4_000 }, (_, index) => `${index % 2 === 0 ? "ignored" : "plain"}-${index}-${"x".repeat(48)}.txt`);
  const second = await session.check(paths);
  assert.equal(second.size, 2_000);
  assert.equal(session.gitProcessesSpawned, 1);
});

test("streaming Git classifier fails open once when Git is unavailable", async (t) => {
  const root = temporaryRoot("portus-git-ignore-missing-");
  const session = new StreamingGitIgnoreSession(root, { command: path.join(root, "missing-git") });
  t.after(async () => {
    await session.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assert.deepEqual([...(await session.check(["first.txt"]))], []);
  assert.deepEqual([...(await session.check(["second.txt"]))], []);
  assert.equal(session.gitProcessesSpawned, 1);
});

test("streaming Git classifier fails open without respawn after malformed output", async (t) => {
  const root = temporaryRoot("portus-git-ignore-malformed-");
  const fakeGit = writeFakeGit(root);
  const session = new StreamingGitIgnoreSession(root, {
    command: process.execPath,
    argsPrefix: [fakeGit],
    env: { PORTUS_FAKE_GIT_MODE: "malformed" }
  });
  t.after(async () => {
    await session.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assert.deepEqual([...(await session.check(["ignored.txt", "plain.txt"]))], []);
  assert.deepEqual([...(await session.check(["another-ignored.txt"]))], []);
  assert.equal(session.gitProcessesSpawned, 1);
});

test("streaming Git classifier settles pending queries after fatal process exit", async (t) => {
  const root = temporaryRoot("portus-git-ignore-fatal-");
  const fakeGit = writeFakeGit(root);
  const session = new StreamingGitIgnoreSession(root, {
    command: process.execPath,
    argsPrefix: [fakeGit],
    env: { PORTUS_FAKE_GIT_MODE: "fatal" }
  });
  t.after(async () => {
    await session.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assert.deepEqual([...(await session.check(["ignored.txt", "plain.txt"]))], []);
  assert.deepEqual([...(await session.check(["another-ignored.txt"]))], []);
  assert.equal(session.gitProcessesSpawned, 1);
});

test("streaming Git classifier closes idempotently before startup", async (t) => {
  const root = temporaryRoot("portus-git-ignore-close-");
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const session = new StreamingGitIgnoreSession(root);

  await session.close();
  await session.close();
  assert.equal(session.gitProcessesSpawned, 0);
  await assert.rejects(() => session.check(["file.txt"]), /session is closed/);
});
