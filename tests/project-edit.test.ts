import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-project-edit-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
writeFileSync(configPath, JSON.stringify({
  subagents: {
    defaultTemplate: "ephemeral-project-subagent",
    retry: {
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 1500,
      maxDelayMs: 15000,
      jitterRatio: 0.2,
      retryOn: ["provider_rate_limited"],
      respectRetryAfter: true,
      maxRetryWindowSecs: 60
    }
  },
  traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp"] }
}, null, 2), "utf8");
writeFileSync(policyPath, JSON.stringify({
  subagents: {
    concurrency: { maxConcurrent: 4, maxConcurrentPerProject: 2, queueEnabled: false, maxQueueDepth: 10 },
    lifecycle: {
      queuedTaskTtlSecs: 300,
      projectLockTimeoutSecs: 1800,
      maxRuntimeSecs: 900,
      startupWatchdogMs: 15000,
      forcedCloseGraceMs: 8000,
      killEscalationDelayMs: 1200,
      queueDrainDelayMs: 50
    },
    permissions: { networkAccess: true, allowedCommands: ["git"] }
  },
  main_agent: {
    permissions: {
      subagentTask: false,
      subagentContext: false,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      projectPatch: false,
      projectRun: false,
      projectPolicy: true, projectScreenshot: false,
      readGitIgnoredFiles: false,
      requireConfirmation: false,
      allowShell: false,
      allowedCommands: ["git"]
    }
  },
  pathPolicy: { blockedPatterns: [".env"] },
  limits: {
    fileRead: { maxChars: 500000 },
    fileWrite: { maxChars: 1000000 },
    patch: { maxChars: 1000000 },
    textEdit: { maxOperationChars: 200000, maxSearchOrMarkerChars: 20000, maxRangeLines: 2000 },
    search: { maxScanEntries: 100000, maxTextFileChars: 200000, maxRegexExecutionMs: 120000, maxBatchMatches: 5000, maxBatchOutputChars: 500000 },
    skills: { maxReadChars: 200000 },
    subagentOutput: { maxStdoutChars: 200000, maxStderrChars: 200000 },
    sessionEvents: { maxEvents: 500, maxChunkChars: 4000 },
    audit: { maxEvents: 1000 },
    process: { maxOutputBufferMb: 10, maxBatchOutputChars: 1000000 }, screenshot: { maxBytes: 8388608, maxWidth: 3840, maxHeight: 2160, captureTimeoutMs: 10000, maxWindowWaitMs: 30000, windowTokenTtlMs: 30000, maxListPageSize: 100, minJpegQuality: 50, maxJpegQuality: 95 }
  },
  audit: { strictMode: false }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";
process.env.PORTUS_MCP_PROJECTS = `edit=${projectRoot}`;

after(() => rmSync(root, { recursive: true, force: true }));

// The server reads these environment-selected paths during module initialization.
const { createHttpServer } = await import("../src/server.js");
const { stateStore } = await import("../src/state/StateStore.js");

function resultOf(response: CallToolResult): Record<string, any> {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  assert(response.structuredContent && typeof response.structuredContent === "object" && "result" in response.structuredContent);
  return response.structuredContent.result as Record<string, any>;
}

async function callEdit(
  client: Client,
  operations: Array<Record<string, unknown>>,
  dryRun = false,
  continueOnFailure = false,
  batchMode?: "staged" | "ordered",
  verifyResult = false
): Promise<CallToolResult> {
  return client.callTool({
    name: "project_edit",
    arguments: {
      projectAlias: "edit",
      operations,
      dryRun,
      continueOnFailure,
      verifyResult,
      ...(batchMode === undefined ? {} : { batchMode })
    }
  });
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertBatchCountInvariant(batch: Record<string, any>): void {
  assert.equal(
    batch.requestedCount,
    batch.successCount + batch.failedCount + batch.errorCount + batch.skippedCount
  );
}

test("project_edit exposes typed exact-edit outcomes", async (t) => {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "project-edit-test", version: "0.1.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  t.after(async () => client.close());

  await t.test("hard-cuts over staged and ordered batch schemas", async () => {
    writeFileSync(path.join(projectRoot, "schema.txt"), "marker\n", "utf8");
    const missingExpected = await callEdit(client, [{ type: "replace", relativePath: "schema.txt", search: "marker", replace: "updated" }]);
    assert.equal(missingExpected.isError, true);
    const zeroExpected = await callEdit(client, [{ type: "replace", relativePath: "schema.txt", search: "marker", replace: "updated", expectedOccurrences: 0 }]);
    assert.equal(zeroExpected.isError, true);
    const unknownOperation = await callEdit(client, [{ type: "touch", relativePath: "schema.txt" }]);
    assert.equal(unknownOperation.isError, true);
    const retiredInsertMultiplicity = await callEdit(client, [{ type: "insert", relativePath: "schema.txt", marker: "marker", content: "before-", position: "before", expectedOccurrences: 1 }]);
    assert.equal(retiredInsertMultiplicity.isError, true);
    const missingRangeHash = await callEdit(client, [{ type: "replace_range", relativePath: "schema.txt", startLine: 1, endLine: 1, replacement: "updated" }]);
    assert.equal(missingRangeHash.isError, true);
    const invalidRangeBound = await callEdit(client, [{ type: "replace_range", relativePath: "schema.txt", expectedSha256: sha256("marker\n"), startLine: 0, endLine: 1, replacement: "updated" }]);
    assert.equal(invalidRangeBound.isError, true);
    assert.equal(readFileSync(path.join(projectRoot, "schema.txt"), "utf8"), "marker\n");
    const invalidMode = await client.callTool({
      name: "project_edit",
      arguments: { projectAlias: "edit", batchMode: "invalid", operations: [{ type: "write", relativePath: "schema.txt", content: "updated" }] }
    });
    assert.equal(invalidMode.isError, true);
    const invalidContinuation = await callEdit(client, [{ type: "write", relativePath: "schema.txt", content: "updated" }], false, true);
    assert.equal(invalidContinuation.isError, true);
    const stagedFilesystemOperation = resultOf(await callEdit(client, [{
      type: "copy",
      sourceRelativePath: "schema.txt",
      destinationRelativePath: "schema-copy.txt"
    }]));
    assert.equal(stagedFilesystemOperation.batchMode, "staged");
    assert.equal(stagedFilesystemOperation.results[0].reason, "unsupported_batch_mode");
    assert.equal(existsSync(path.join(projectRoot, "schema-copy.txt")), false);
  });

  await t.test("reports zero matches as a completed rejection without touching the file", async () => {
    const target = path.join(projectRoot, "missing-match.txt");
    writeFileSync(target, "unchanged\n", "utf8");
    const before = statSync(target).mtimeMs;
    const batch = resultOf(await callEdit(client, [{ type: "replace", relativePath: "missing-match.txt", search: "absent", replace: "new", expectedOccurrences: 1 }]));
    assertBatchCountInvariant(batch);
    assert.deepEqual({
      batchMode: batch.batchMode,
      batchOutcome: batch.batchOutcome,
      repositoryState: batch.repositoryState,
      successCount: batch.successCount,
      failedCount: batch.failedCount,
      errorCount: batch.errorCount,
      appliedCount: batch.appliedCount
    }, {
      batchMode: "staged",
      batchOutcome: "rejected",
      repositoryState: "unchanged",
      successCount: 0,
      failedCount: 1,
      errorCount: 0,
      appliedCount: 0
    });
    assert.deepEqual(batch.results[0], {
      index: 0,
      type: "replace",
      relativePath: "missing-match.txt",
      ok: false,
      outcome: "completed",
      operationStatus: "not_applied",
      reason: "occurrence_mismatch",
      fileChanged: false,
      expectedOccurrences: 1,
      matchesFound: 0,
      exactMatchLocations: [],
      locationsTruncated: false,
      matchesApplied: 0
    });
    assert.equal(readFileSync(target, "utf8"), "unchanged\n");
    assert.equal(statSync(target).mtimeMs, before);
  });

  await t.test("rejects excess replacement matches without touching the file", async () => {
    const target = path.join(projectRoot, "excess-match.txt");
    const source = "marker\nmarker\n";
    writeFileSync(target, source, "utf8");
    const before = statSync(target).mtimeMs;
    const batch = resultOf(await callEdit(client, [{
      type: "replace",
      relativePath: "excess-match.txt",
      search: "marker",
      replace: "updated",
      expectedOccurrences: 1
    }]));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.repositoryState, "unchanged");
    assert.equal(batch.results[0].reason, "occurrence_mismatch");
    assert.equal(batch.results[0].expectedOccurrences, 1);
    assert.equal(batch.results[0].matchesFound, 2);
    assert.equal(batch.results[0].matchesApplied, 0);
    assert.deepEqual(batch.results[0].exactMatchLocations, [{ line: 1, column: 1 }, { line: 2, column: 1 }]);
    assert.equal(readFileSync(target, "utf8"), source);
    assert.equal(statSync(target).mtimeMs, before);
  });

  await t.test("replaces the exact declared count and reports Unicode locations", async () => {
    const target = path.join(projectRoot, "locations.txt");
    writeFileSync(target, "🙂x needle\nneedle\n", "utf8");
    const batch = resultOf(await callEdit(client, [{ type: "replace", relativePath: "locations.txt", search: "needle", replace: "done", expectedOccurrences: 2 }]));
    assert.equal(batch.batchOutcome, "succeeded");
    assert.equal(batch.repositoryState, "changed");
    assert.equal(batch.appliedCount, 1);
    assert.deepEqual(batch.results[0].exactMatchLocations, [{ line: 1, column: 4 }, { line: 2, column: 1 }]);
    assert.equal(batch.results[0].matchesFound, 2);
    assert.equal(batch.results[0].matchesApplied, 2);
    assert.equal(batch.results[0].operationStatus, "applied");
    assert.equal(batch.results[0].oldSha256, sha256("🙂x needle\nneedle\n"));
    assert.equal(batch.results[0].newSha256, sha256("🙂x done\ndone\n"));
    assert.equal(readFileSync(target, "utf8"), "🙂x done\ndone\n");
  });
  await t.test("uses non-overlapping matches and preserves CRLF insertion placement", async () => {
    const target = path.join(projectRoot, "non-overlap-crlf.txt");
    writeFileSync(target, "aaa\r\nmarker\r\n", "utf8");
    const replacement = resultOf(await callEdit(client, [{ type: "replace", relativePath: "non-overlap-crlf.txt", search: "aa", replace: "X", expectedOccurrences: 1 }]));
    assert.deepEqual(replacement.results[0].exactMatchLocations, [{ line: 1, column: 1 }]);
    assert.equal("occurrences" in replacement.results[0], false);
    assert.equal("bytesWritten" in replacement.results[0], false);
    assert.equal("atomic" in replacement, false);
    const insertion = resultOf(await callEdit(client, [{ type: "insert", relativePath: "non-overlap-crlf.txt", marker: "marker", content: "!", position: "after" }]));
    assert.deepEqual(insertion.results[0].exactMatchLocations, [{ line: 2, column: 1 }]);
    assert.equal(insertion.results[0].matchesApplied, 1);
    assert.equal(replacement.results[0].oldSha256, sha256("aaa\r\nmarker\r\n"));
    assert.equal(replacement.results[0].newSha256, sha256("Xa\r\nmarker\r\n"));
    assert.equal(insertion.results[0].oldSha256, sha256("Xa\r\nmarker\r\n"));
    assert.equal(insertion.results[0].newSha256, sha256("Xa\r\nmarker!\r\n"));
    assert.equal(readFileSync(target, "utf8"), "Xa\r\nmarker!\r\n");
  });

  await t.test("requires a unique insert marker and applies before and after placement", async () => {
    const absentTarget = path.join(projectRoot, "insert-absent.txt");
    writeFileSync(absentTarget, "source\n", "utf8");
    const absent = resultOf(await callEdit(client, [{
      type: "insert",
      relativePath: "insert-absent.txt",
      marker: "missing",
      content: "new",
      position: "before"
    }]));
    assert.equal(absent.batchOutcome, "rejected");
    assert.equal(absent.results[0].reason, "occurrence_mismatch");
    assert.equal(absent.results[0].matchesFound, 0);
    assert.equal(absent.results[0].matchesApplied, 0);
    assert.equal(readFileSync(absentTarget, "utf8"), "source\n");

    const target = path.join(projectRoot, "insert-placement.txt");
    writeFileSync(target, "marker\n", "utf8");
    const before = resultOf(await callEdit(client, [{
      type: "insert",
      relativePath: "insert-placement.txt",
      marker: "marker",
      content: "before-",
      position: "before"
    }]));
    assert.equal(before.results[0].operationStatus, "applied");
    assert.equal(before.results[0].matchesApplied, 1);
    assert.equal(before.results[0].oldSha256, sha256("marker\n"));
    assert.equal(before.results[0].newSha256, sha256("before-marker\n"));
    assert.equal(readFileSync(target, "utf8"), "before-marker\n");
    const after = resultOf(await callEdit(client, [{
      type: "insert",
      relativePath: "insert-placement.txt",
      marker: "marker",
      content: "-after",
      position: "after"
    }]));
    assert.equal(after.results[0].operationStatus, "applied");
    assert.equal(after.results[0].matchesApplied, 1);
    assert.equal(after.results[0].oldSha256, sha256("before-marker\n"));
    assert.equal(after.results[0].newSha256, sha256("before-marker-after\n"));
    assert.equal(readFileSync(target, "utf8"), "before-marker-after\n");
  });


  await t.test("rejects duplicate insert markers and bounds exact locations", async () => {
    const target = path.join(projectRoot, "duplicate.txt");
    const content = Array.from({ length: 25 }, () => "marker").join("\n") + "\n";
    writeFileSync(target, content, "utf8");
    const batch = resultOf(await callEdit(client, [{ type: "insert", relativePath: "duplicate.txt", marker: "marker", content: "before-", position: "before" }]));
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.results[0].reason, "occurrence_mismatch");
    assert.equal(batch.results[0].expectedOccurrences, 1);
    assert.equal(batch.results[0].matchesFound, 25);
    assert.equal(batch.results[0].exactMatchLocations.length, 20);
    assert.equal(batch.results[0].locationsTruncated, true);
    assert.equal(batch.results[0].matchesApplied, 0);
    assert.equal(readFileSync(target, "utf8"), content);
  });

  await t.test("does not write content-identical edits or writes", async () => {
    const target = path.join(projectRoot, "no-change.txt");
    writeFileSync(target, "same\n", "utf8");
    const before = statSync(target).mtimeMs;
    const replaceBatch = resultOf(await callEdit(client, [{ type: "replace", relativePath: "no-change.txt", search: "same", replace: "same", expectedOccurrences: 1 }]));
    assert.equal(replaceBatch.results[0].operationStatus, "no_change");
    assert.equal(replaceBatch.results[0].matchesApplied, 0);
    const writeBatch = resultOf(await callEdit(client, [{ type: "write", relativePath: "no-change.txt", content: "same\n", expectedSha256: sha256("same\n") }]));
    assert.equal(writeBatch.results[0].operationStatus, "no_change");
    assert.equal(writeBatch.noChangeCount, 1);
    assert.equal(writeBatch.repositoryState, "unchanged");
    assert.equal(statSync(target).mtimeMs, before);
    assert.equal(replaceBatch.results[0].oldSha256, sha256("same\n"));
    assert.equal(replaceBatch.results[0].newSha256, sha256("same\n"));
    assert.equal(writeBatch.results[0].oldSha256, sha256("same\n"));
    assert.equal(writeBatch.results[0].newSha256, sha256("same\n"));
  });

  await t.test("distinguishes dry-run plans from applied mutations", async () => {
    const target = path.join(projectRoot, "dry-run.txt");
    writeFileSync(target, "marker\n", "utf8");
    const batch = resultOf(await callEdit(client, [{ type: "insert", relativePath: "dry-run.txt", marker: "marker", content: "before-", position: "before" }], true));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchOutcome, "planned");
    assert.equal(batch.plannedCount, 1);
    assert.equal(batch.appliedCount, 0);
    assert.equal(batch.repositoryState, "unchanged");
    assert.equal(batch.results[0].operationStatus, "planned");
    assert.equal(batch.results[0].matchesPlanned, 1);
    assert.equal(batch.results[0].fileChanged, false);
    assert.equal(batch.results[0].oldSha256, sha256("marker\n"));
    assert.equal(batch.results[0].projectedSha256, sha256("before-marker\n"));
    assert.equal(readFileSync(target, "utf8"), "marker\n");
  });

  await t.test("returns bounded resulting content when verification is requested", async () => {
    const target = path.join(projectRoot, "verify-result.txt");
    const content = "first\nsecond\n";
    const batch = resultOf(await callEdit(client, [{
      type: "write",
      relativePath: "verify-result.txt",
      content
    }], false, false, undefined, true));
    assert.deepEqual(batch.verification.files, [{
      relativePath: "verify-result.txt",
      resultingRange: { startLine: 1, endLine: 2 },
      content,
      truncated: false
    }]);
    assert.equal(readFileSync(target, "utf8"), content);
  });

  await t.test("returns structured stale-file rejection", async () => {
    const target = path.join(projectRoot, "stale.txt");
    writeFileSync(target, "current\n", "utf8");
    const batch = resultOf(await callEdit(client, [{ type: "write", relativePath: "stale.txt", content: "updated\n", expectedSha256: sha256("old\n") }]));
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.errorCount, 0);
    assert.equal(batch.results[0].reason, "stale_file");
    assert.equal(batch.results[0].operationStatus, "not_applied");
    assert.equal(batch.results[0].expectedSha256, sha256("old\n"));
    assert.equal(batch.results[0].actualSha256, sha256("current\n"));
    assert.equal(readFileSync(target, "utf8"), "current\n");
  });
  await t.test("applies guarded ranges while preserving CRLF and missing-final-newline state", async () => {
    const crlfTarget = path.join(projectRoot, "range-crlf.txt");
    const crlfSource = Buffer.from("one\r\ntwo\r\nthree\r\n");
    const crlfUpdated = Buffer.from("one\r\nTWO\r\nSECOND\r\nthree\r\n");
    writeFileSync(crlfTarget, crlfSource);
    const crlfBatch = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-crlf.txt",
      expectedSha256: sha256(crlfSource).toUpperCase(),
      startLine: 2,
      endLine: 2,
      replacement: "TWO\nSECOND"
    }]));
    assert.deepEqual(crlfBatch.results[0], {
      index: 0,
      type: "replace_range",
      relativePath: "range-crlf.txt",
      ok: true,
      outcome: "completed",
      operationStatus: "applied",
      fileChanged: true,
      oldRange: { startLine: 2, endLine: 2 },
      newRange: { startLine: 2, endLine: 3 },
      oldSha256: sha256(crlfSource),
      newSha256: sha256(crlfUpdated)
    });
    assert.deepEqual(readFileSync(crlfTarget), crlfUpdated);

    const noFinalTarget = path.join(projectRoot, "range-no-final.txt");
    const noFinalSource = Buffer.from("first\nlast");
    const noFinalUpdated = Buffer.from("first\n🙂\nfinal");
    writeFileSync(noFinalTarget, noFinalSource);
    const noFinalBatch = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-no-final.txt",
      expectedSha256: sha256(noFinalSource),
      startLine: 2,
      endLine: 2,
      replacement: "🙂\r\nfinal\r\n"
    }]));
    assert.deepEqual(noFinalBatch.results[0].newRange, { startLine: 2, endLine: 3 });
    assert.equal(noFinalBatch.results[0].newSha256, sha256(noFinalUpdated));
    assert.deepEqual(readFileSync(noFinalTarget), noFinalUpdated);
  });

  await t.test("replaces first, last, and whole-file line ranges", async () => {
    const target = path.join(projectRoot, "range-boundaries.txt");
    const initial = Buffer.from("first\nmiddle\nlast\n");
    writeFileSync(target, initial);
    const firstUpdated = Buffer.from("FIRST\nmiddle\nlast\n");
    const first = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-boundaries.txt",
      expectedSha256: sha256(initial),
      startLine: 1,
      endLine: 1,
      replacement: "FIRST"
    }]));
    assert.deepEqual(first.results[0].oldRange, { startLine: 1, endLine: 1 });
    assert.deepEqual(first.results[0].newRange, { startLine: 1, endLine: 1 });
    assert.deepEqual(readFileSync(target), firstUpdated);

    const lastUpdated = Buffer.from("FIRST\nmiddle\nLAST\n");
    const last = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-boundaries.txt",
      expectedSha256: sha256(firstUpdated),
      startLine: 3,
      endLine: 3,
      replacement: "LAST"
    }]));
    assert.deepEqual(last.results[0].oldRange, { startLine: 3, endLine: 3 });
    assert.deepEqual(last.results[0].newRange, { startLine: 3, endLine: 3 });
    assert.deepEqual(readFileSync(target), lastUpdated);

    const wholeUpdated = Buffer.from("replacement\n");
    const whole = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-boundaries.txt",
      expectedSha256: sha256(lastUpdated),
      startLine: 1,
      endLine: 3,
      replacement: "replacement"
    }]));
    assert.deepEqual(whole.results[0].oldRange, { startLine: 1, endLine: 3 });
    assert.deepEqual(whole.results[0].newRange, { startLine: 1, endLine: 1 });
    assert.equal(whole.results[0].newSha256, sha256(wholeUpdated));
    assert.deepEqual(readFileSync(target), wholeUpdated);
  });

  await t.test("deletes a complete range without disturbing surrounding bytes", async () => {
    const target = path.join(projectRoot, "range-delete.txt");
    const source = Buffer.from("alpha\nremove one\nremove two\nomega\n");
    const updated = Buffer.from("alpha\nomega\n");
    writeFileSync(target, source);
    const batch = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-delete.txt",
      expectedSha256: sha256(source),
      startLine: 2,
      endLine: 3,
      replacement: ""
    }]));
    assert.equal(batch.results[0].operationStatus, "applied");
    assert.deepEqual(batch.results[0].oldRange, { startLine: 2, endLine: 3 });
    assert.equal(batch.results[0].newRange, null);
    assert.equal(batch.results[0].newSha256, sha256(updated));
    assert.deepEqual(readFileSync(target), updated);
  });

  await t.test("returns no_change for an identical guarded range without touching the file", async () => {
    const target = path.join(projectRoot, "range-no-change.txt");
    const source = Buffer.from("same\r\n");
    writeFileSync(target, source);
    const before = statSync(target).mtimeMs;
    const batch = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-no-change.txt",
      expectedSha256: sha256(source),
      startLine: 1,
      endLine: 1,
      replacement: "same"
    }]));
    assert.equal(batch.results[0].operationStatus, "no_change");
    assert.equal(batch.results[0].fileChanged, false);
    assert.equal(batch.results[0].oldSha256, sha256(source));
    assert.equal(batch.results[0].newSha256, sha256(source));
    assert.equal(statSync(target).mtimeMs, before);
  });

  await t.test("plans guarded range hashes and ranges without mutation", async () => {
    const target = path.join(projectRoot, "range-dry-run.txt");
    const source = Buffer.from("alpha\nomega\n");
    const projected = Buffer.from("first\nsecond\nomega\n");
    writeFileSync(target, source);
    const batch = resultOf(await callEdit(client, [{
      type: "replace_range",
      relativePath: "range-dry-run.txt",
      expectedSha256: sha256(source),
      startLine: 1,
      endLine: 1,
      replacement: "first\nsecond"
    }], true));
    assert.equal(batch.batchOutcome, "planned");
    assert.equal(batch.results[0].operationStatus, "planned");
    assert.deepEqual(batch.results[0].oldRange, { startLine: 1, endLine: 1 });
    assert.deepEqual(batch.results[0].projectedNewRange, { startLine: 1, endLine: 2 });
    assert.equal(batch.results[0].oldSha256, sha256(source));
    assert.equal(batch.results[0].projectedSha256, sha256(projected));
    assert.equal(batch.results[0].fileChanged, false);
    assert.deepEqual(readFileSync(target), source);
  });

  await t.test("rejects stale, reversed, unavailable, and overwide ranges without mutation", async () => {
    const target = path.join(projectRoot, "range-rejected.txt");
    const source = Buffer.from("one\ntwo\nthree\n");
    writeFileSync(target, source);
    const before = statSync(target).mtimeMs;
    const operations = [
      { expectedSha256: sha256("stale\n"), startLine: 1, endLine: 1, reason: "stale_file" },
      { expectedSha256: sha256(source), startLine: 3, endLine: 2, reason: "invalid_range" },
      { expectedSha256: sha256(source), startLine: 2, endLine: 4, reason: "invalid_range" },
      { expectedSha256: sha256(source), startLine: 1, endLine: 2001, reason: "invalid_range" }
    ];
    for (const operation of operations) {
      const batch = resultOf(await callEdit(client, [{
        type: "replace_range",
        relativePath: "range-rejected.txt",
        expectedSha256: operation.expectedSha256,
        startLine: operation.startLine,
        endLine: operation.endLine,
        replacement: "changed"
      }]));
      assert.equal(batch.batchOutcome, "rejected");
      assert.equal(batch.results[0].reason, operation.reason);
      assert.equal(batch.results[0].operationStatus, "not_applied");
      assert.equal(batch.results[0].fileChanged, false);
      assert.deepEqual(readFileSync(target), source);
    }
    assert.equal(statSync(target).mtimeMs, before);
  });
  await t.test("stages same-file operations against projected state and writes once", async () => {
    const target = path.join(projectRoot, "staged-compose.txt");
    const source = Buffer.from("alpha\nbeta\n");
    const expected = Buffer.from("ALPHA\nBETA\nSECOND\n");
    writeFileSync(target, source);
    const before = statSync(target).mtimeMs;
    const baseHash = sha256(source);
    const batch = resultOf(await callEdit(client, [
      {
        type: "replace",
        relativePath: "staged-compose.txt",
        search: "alpha",
        replace: "ALPHA",
        expectedOccurrences: 1,
        expectedSha256: baseHash
      },
      {
        type: "replace_range",
        relativePath: "staged-compose.txt",
        expectedSha256: baseHash,
        startLine: 2,
        endLine: 2,
        replacement: "BETA\nSECOND"
      }
    ]));
    assert.equal(batch.batchMode, "staged");
    assert.equal(batch.batchOutcome, "succeeded");
    assert.equal(batch.appliedCount, 2);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.operationStatus), ["applied", "applied"]);
    assert.equal(batch.results[0].oldSha256, baseHash);
    assert.equal(batch.results[0].newSha256, sha256("ALPHA\nbeta\n"));
    assert.deepEqual(batch.results[1].newRange, { startLine: 2, endLine: 3 });
    assert.equal(batch.results[1].oldSha256, sha256("ALPHA\nbeta\n"));
    assert.deepEqual(readFileSync(target), expected);
    assert(statSync(target).mtimeMs >= before);
  });

  await t.test("continues evaluating same-path operations after a semantic rejection", async () => {
    const target = path.join(projectRoot, "staged-rejection-continuation.txt");
    const source = Buffer.from("one\ntwo\nthree\n");
    writeFileSync(target, source);
    const before = statSync(target).mtimeMs;
    const operations = [
      { type: "replace", relativePath: "staged-rejection-continuation.txt", search: "one", replace: "ONE", expectedOccurrences: 1 },
      { type: "replace", relativePath: "staged-rejection-continuation.txt", search: "two", replace: "TWO", expectedOccurrences: 1 },
      { type: "replace", relativePath: "staged-rejection-continuation.txt", search: "DOES_NOT_EXIST", replace: "FAIL", expectedOccurrences: 1 },
      { type: "replace", relativePath: "staged-rejection-continuation.txt", search: "three", replace: "THREE", expectedOccurrences: 1 }
    ];
    const batch = resultOf(await callEdit(client, operations));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.repositoryState, "unchanged");
    assert.equal(batch.successCount, 0);
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.errorCount, 0);
    assert.equal(batch.appliedCount, 0);
    assert.equal(batch.skippedCount, 3);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => ({
      outcome: result.outcome,
      operationStatus: result.operationStatus,
      reason: result.reason
    })), [
      { outcome: "skipped", operationStatus: "skipped", reason: "batch_rejected" },
      { outcome: "skipped", operationStatus: "skipped", reason: "batch_rejected" },
      { outcome: "completed", operationStatus: "not_applied", reason: "occurrence_mismatch" },
      { outcome: "skipped", operationStatus: "skipped", reason: "batch_rejected" }
    ]);
    assert.equal(batch.results[2].matchesFound, 0);
    assert.equal(batch.results[2].matchesApplied, 0);
    assert.deepEqual(readFileSync(target), source);
    assert.equal(statSync(target).mtimeMs, before);

    const dryRun = resultOf(await callEdit(client, operations, true));
    assertBatchCountInvariant(dryRun);
    assert.equal(dryRun.batchOutcome, "rejected");
    assert.equal(dryRun.repositoryState, "unchanged");
    assert.equal(dryRun.successCount, 3);
    assert.equal(dryRun.failedCount, 1);
    assert.equal(dryRun.plannedCount, 3);
    assert.equal(dryRun.skippedCount, 0);
    assert.deepEqual(dryRun.results.map((result: Record<string, unknown>) => result.operationStatus), [
      "planned",
      "planned",
      "not_applied",
      "planned"
    ]);
    assert.deepEqual(readFileSync(target), source);
    assert.equal(statSync(target).mtimeMs, before);
  });

  await t.test("collects multiple semantic rejections on one staged path", async () => {
    const target = path.join(projectRoot, "staged-same-path-rejections.txt");
    const source = Buffer.from("one\ntwo\n");
    writeFileSync(target, source);
    const batch = resultOf(await callEdit(client, [
      { type: "replace", relativePath: "staged-same-path-rejections.txt", search: "missing-one", replace: "FAIL", expectedOccurrences: 1 },
      { type: "replace", relativePath: "staged-same-path-rejections.txt", search: "one", replace: "ONE", expectedOccurrences: 1 },
      { type: "replace", relativePath: "staged-same-path-rejections.txt", search: "missing-two", replace: "FAIL", expectedOccurrences: 1 }
    ]));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.failedCount, 2);
    assert.equal(batch.skippedCount, 1);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.reason), [
      "occurrence_mismatch",
      "batch_rejected",
      "occurrence_mismatch"
    ]);
    assert.deepEqual(readFileSync(target), source);
  });

  await t.test("does not let a stale hash poison later same-path base guards", async () => {
    const target = path.join(projectRoot, "staged-stale-continuation.txt");
    const source = Buffer.from("one\n");
    writeFileSync(target, source);
    const batch = resultOf(await callEdit(client, [
      {
        type: "replace",
        relativePath: "staged-stale-continuation.txt",
        search: "one",
        replace: "STALE",
        expectedOccurrences: 1,
        expectedSha256: sha256("stale\n")
      },
      {
        type: "replace",
        relativePath: "staged-stale-continuation.txt",
        search: "one",
        replace: "ONE",
        expectedOccurrences: 1,
        expectedSha256: sha256(source)
      }
    ]));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.skippedCount, 1);
    assert.equal(batch.results[0].reason, "stale_file");
    assert.equal(batch.results[1].reason, "batch_rejected");
    assert.deepEqual(readFileSync(target), source);
  });

  await t.test("continues after operation-local failures but skips unavailable projections", async () => {
    const target = path.join(projectRoot, "staged-failure-continuation.txt");
    const source = Buffer.from("one\n");
    writeFileSync(target, source);
    const continued = resultOf(await callEdit(client, [
      {
        type: "replace",
        relativePath: "staged-failure-continuation.txt",
        search: "one",
        replace: "x".repeat(200001),
        expectedOccurrences: 1
      },
      {
        type: "replace",
        relativePath: "staged-failure-continuation.txt",
        search: "one",
        replace: "ONE",
        expectedOccurrences: 1
      }
    ]));
    assertBatchCountInvariant(continued);
    assert.equal(continued.batchOutcome, "failed");
    assert.equal(continued.errorCount, 1);
    assert.equal(continued.skippedCount, 1);
    assert.equal(continued.results[0].operationStatus, "failed");
    assert.equal(continued.results[1].reason, "batch_failed");
    assert.deepEqual(readFileSync(target), source);

    const directoryTarget = path.join(projectRoot, "staged-unavailable-projection");
    mkdirSync(directoryTarget, { recursive: true });
    const unavailable = resultOf(await callEdit(client, [
      { type: "write", relativePath: "staged-unavailable-projection", content: "first\n" },
      { type: "write", relativePath: "staged-unavailable-projection", content: "second\n" }
    ]));
    assertBatchCountInvariant(unavailable);
    assert.equal(unavailable.batchOutcome, "failed");
    assert.equal(unavailable.errorCount, 1);
    assert.equal(unavailable.skippedCount, 1);
    assert.equal(unavailable.results[0].operationStatus, "failed");
    assert.equal(unavailable.results[1].reason, "prior_operation_failed");
    assert.equal(statSync(directoryTarget).isDirectory(), true);
  });

  await t.test("rejects conflicting same-path hashes and withholds valid changes", async () => {
    const target = path.join(projectRoot, "staged-conflict.txt");
    const source = Buffer.from("alpha\n");
    writeFileSync(target, source);
    const before = statSync(target).mtimeMs;
    const batch = resultOf(await callEdit(client, [
      {
        type: "replace",
        relativePath: "staged-conflict.txt",
        search: "alpha",
        replace: "ALPHA",
        expectedOccurrences: 1,
        expectedSha256: sha256(source)
      },
      {
        type: "insert",
        relativePath: "staged-conflict.txt",
        marker: "ALPHA",
        content: "before-",
        position: "before",
        expectedSha256: sha256("different\n")
      }
    ]));
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.skippedCount, 1);
    assert.equal(batch.results[0].reason, "batch_rejected");
    assert.equal(batch.results[1].reason, "conflicting_base_hash");
    assert.deepEqual(readFileSync(target), source);
    assert.equal(statSync(target).mtimeMs, before);
  });

  await t.test("collects independent staged rejections and preserves successful no-change results", async () => {
    writeFileSync(path.join(projectRoot, "staged-invalid-a.txt"), "alpha\n", "utf8");
    writeFileSync(path.join(projectRoot, "staged-invalid-b.txt"), "beta\n", "utf8");
    writeFileSync(path.join(projectRoot, "staged-no-change.txt"), "same\n", "utf8");
    const batch = resultOf(await callEdit(client, [
      {
        type: "replace",
        relativePath: "staged-invalid-a.txt",
        search: "missing",
        replace: "updated",
        expectedOccurrences: 1
      },
      {
        type: "replace",
        relativePath: "staged-invalid-b.txt",
        search: "absent",
        replace: "updated",
        expectedOccurrences: 1
      },
      {
        type: "write",
        relativePath: "staged-no-change.txt",
        content: "same\n"
      },
      {
        type: "write",
        relativePath: "staged-withheld.txt",
        content: "withheld\n"
      }
    ]));
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.failedCount, 2);
    assert.equal(batch.successCount, 1);
    assert.equal(batch.noChangeCount, 1);
    assert.equal(batch.skippedCount, 1);
    assert.equal(batch.results[2].operationStatus, "no_change");
    assert.equal(batch.results[3].reason, "batch_rejected");
    assert.equal(existsSync(path.join(projectRoot, "staged-withheld.txt")), false);
  });

  await t.test("classifies staged execution errors separately from semantic rejections", async () => {
    mkdirSync(path.join(projectRoot, "staged-directory-target"), { recursive: true });
    const withheldTarget = path.join(projectRoot, "staged-withheld-on-error.txt");
    const batch = resultOf(await callEdit(client, [
      { type: "write", relativePath: "staged-withheld-on-error.txt", content: "withheld\n" },
      { type: "write", relativePath: "staged-directory-target", content: "cannot replace a directory\n" }
    ]));
    assert.equal(batch.batchOutcome, "failed");
    assert.equal(batch.repositoryState, "unchanged");
    assert.equal(batch.successCount, 0);
    assert.equal(batch.failedCount, 0);
    assert.equal(batch.errorCount, 1);
    assert.equal(batch.skippedCount, 1);
    assert.equal(batch.requestedCount, batch.successCount + batch.failedCount + batch.errorCount + batch.skippedCount);
    assert.equal(batch.results[0].operationStatus, "skipped");
    assert.equal(batch.results[0].reason, "batch_failed");
    assert.equal(batch.results[1].operationStatus, "failed");
    assert.equal(batch.results[1].fileChanged, false);
    assert.equal(existsSync(withheldTarget), false);
  });

  await t.test("returns projected staged dry-run results without mutation", async () => {
    const target = path.join(projectRoot, "staged-dry-run.txt");
    const source = Buffer.from("alpha\nbeta\n");
    writeFileSync(target, source);
    const baseHash = sha256(source);
    const batch = resultOf(await callEdit(client, [
      {
        type: "replace",
        relativePath: "staged-dry-run.txt",
        search: "alpha",
        replace: "ALPHA",
        expectedOccurrences: 1,
        expectedSha256: baseHash
      },
      {
        type: "insert",
        relativePath: "staged-dry-run.txt",
        marker: "ALPHA",
        content: "before-",
        position: "before",
        expectedSha256: baseHash
      }
    ], true));
    assert.equal(batch.batchOutcome, "planned");
    assert.equal(batch.plannedCount, 2);
    assert.equal(batch.appliedCount, 0);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.operationStatus), ["planned", "planned"]);
    assert.deepEqual(readFileSync(target), source);
  });

  await t.test("collapses canceling same-path changes to no-change without a write", async () => {
    const target = path.join(projectRoot, "staged-cancel.txt");
    const source = Buffer.from("alpha\n");
    writeFileSync(target, source);
    const before = statSync(target).mtimeMs;
    const baseHash = sha256(source);
    const batch = resultOf(await callEdit(client, [
      {
        type: "replace",
        relativePath: "staged-cancel.txt",
        search: "alpha",
        replace: "ALPHA",
        expectedOccurrences: 1,
        expectedSha256: baseHash
      },
      {
        type: "replace",
        relativePath: "staged-cancel.txt",
        search: "ALPHA",
        replace: "alpha",
        expectedOccurrences: 1,
        expectedSha256: baseHash
      }
    ]));
    assert.equal(batch.batchOutcome, "succeeded");
    assert.equal(batch.appliedCount, 0);
    assert.equal(batch.noChangeCount, 2);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.operationStatus), ["no_change", "no_change"]);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.matchesApplied), [0, 0]);
    assert.deepEqual(readFileSync(target), source);
    assert.equal(statSync(target).mtimeMs, before);
  });


  await t.test("rejects a pre-commit disk change without applying staged output", async () => {
    const target = path.join(projectRoot, "staged-stale-gate.txt");
    const source = Buffer.from("alpha\n");
    const external = Buffer.from("external\n");
    writeFileSync(target, source);
    const originalRequireAuditWritable = stateStore.requireAuditWritable;
    stateStore.requireAuditWritable = (): void => {
      writeFileSync(target, external);
    };
    try {
      const batch = resultOf(await callEdit(client, [{
        type: "replace",
        relativePath: "staged-stale-gate.txt",
        search: "alpha",
        replace: "ALPHA",
        expectedOccurrences: 1,
        expectedSha256: sha256(source)
      }]));
      assert.equal(batch.batchOutcome, "rejected");
      assert.equal(batch.repositoryState, "unchanged");
      assert.equal(batch.failedCount, 1);
      assert.equal(batch.results[0].reason, "stale_file");
      assert.deepEqual(readFileSync(target), external);
    } finally {
      stateStore.requireAuditWritable = originalRequireAuditWritable;
    }
  });
  await t.test("reports partial staged commit failures from the commit journal", async () => {
    const parentTarget = path.join(projectRoot, "staged-commit-parent");
    const childTarget = path.join(parentTarget, "child.txt");
    const batch = resultOf(await callEdit(client, [
      { type: "write", relativePath: "staged-commit-parent", content: "parent file\n" },
      { type: "write", relativePath: "staged-commit-parent/child.txt", content: "child file\n" }
    ]));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchMode, "staged");
    assert.equal(batch.batchOutcome, "partial");
    assert.equal(batch.repositoryState, "partially_changed");
    assert.equal(batch.appliedCount, 1);
    assert.equal(batch.skippedCount, 1);
    assert.equal(batch.results[0].operationStatus, "applied");
    assert.equal(batch.results[1].operationStatus, "skipped");
    assert.equal(batch.results[1].reason, "batch_failed");
    assert.match(String(batch.batchError), /EEXIST|ENOTDIR|not a directory|file already exists/i);
    assert.equal(String(batch.batchError).includes(root), false);
    assert.equal(readFileSync(parentTarget, "utf8"), "parent file\n");
    assert.equal(existsSync(childTarget), false);
  });


  await t.test("summarizes ordered partial mutation accurately", async () => {
    const created = path.join(projectRoot, "partial.txt");
    const batch = resultOf(await callEdit(client, [
      { type: "write", relativePath: "partial.txt", content: "created\n" },
      { type: "replace", relativePath: "partial.txt", search: "absent", replace: "updated", expectedOccurrences: 1 }
    ], false, false, "ordered"));
    assert.equal(batch.batchOutcome, "partial");
    assert.equal(batch.repositoryState, "partially_changed");
    assert.equal(batch.successCount, 1);
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.errorCount, 0);
    assert.equal(batch.appliedCount, 1);
    assert.equal(batch.requestedCount, batch.successCount + batch.failedCount + batch.errorCount + batch.skippedCount);
    assert.equal(readFileSync(created, "utf8"), "created\n");
  });
  await t.test("skips later ordered operations after a rejection by default", async () => {
    writeFileSync(path.join(projectRoot, "stop.txt"), "source\n", "utf8");
    const skippedTarget = path.join(projectRoot, "must-not-exist.txt");
    const batch = resultOf(await callEdit(client, [
      { type: "replace", relativePath: "stop.txt", search: "absent", replace: "updated", expectedOccurrences: 1 },
      { type: "write", relativePath: "must-not-exist.txt", content: "not written\n" }
    ], false, false, "ordered"));
    assert.equal(batch.batchOutcome, "rejected");
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.skippedCount, 1);
    assert.equal(batch.results[1].outcome, "skipped");
    assert.equal(batch.results[1].operationStatus, "skipped");
    assert.equal(batch.results[1].reason, "prior_operation_failed");
    assert.equal(batch.results[1].fileChanged, false);
    assert.equal(existsSync(skippedTarget), false);
  });

  await t.test("continues ordered execution only when explicitly requested", async () => {
    const continuedTarget = path.join(projectRoot, "continued.txt");
    const batch = resultOf(await callEdit(client, [
      { type: "replace", relativePath: "stop.txt", search: "absent", replace: "updated", expectedOccurrences: 1 },
      { type: "write", relativePath: "continued.txt", content: "written\n" }
    ], false, true, "ordered"));
    assert.equal(batch.batchOutcome, "partial");
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.appliedCount, 1);
    assert.equal(batch.skippedCount, 0);
    assert.equal(batch.repositoryState, "partially_changed");
    assert.equal(readFileSync(continuedTarget, "utf8"), "written\n");
  });


  await t.test("removes an empty directory created earlier in the same ordered batch", async () => {
    const target = path.join(projectRoot, "ordered-empty-directory");
    const batch = resultOf(await callEdit(client, [
      { type: "mkdir", relativePath: "ordered-empty-directory", recursive: false },
      { type: "rmdir", relativePath: "ordered-empty-directory", recursive: false, confirm: true }
    ], false, false, "ordered"));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchOutcome, "succeeded");
    assert.equal(batch.repositoryState, "changed");
    assert.equal(batch.appliedCount, 2);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.operationStatus), ["applied", "applied"]);
    assert.equal(existsSync(target), false);
  });

  await t.test("preserves a non-empty directory when nonrecursive removal fails", async () => {
    const target = path.join(projectRoot, "ordered-nonempty-directory");
    const child = path.join(target, "child.txt");
    mkdirSync(target);
    writeFileSync(child, "keep\n", "utf8");
    const batch = resultOf(await callEdit(client, [
      { type: "rmdir", relativePath: "ordered-nonempty-directory", recursive: false, confirm: true }
    ], false, false, "ordered"));
    assertBatchCountInvariant(batch);
    assert.equal(batch.batchOutcome, "failed");
    assert.equal(batch.errorCount, 1);
    assert.equal(batch.results[0].operationStatus, "failed");
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(child, "utf8"), "keep\n");
  });

  await t.test("uses typed results for ordered filesystem operations", async () => {
    writeFileSync(path.join(projectRoot, "copy-source.txt"), "copy\n", "utf8");
    const batch = resultOf(await callEdit(client, [
      { type: "copy", sourceRelativePath: "copy-source.txt", destinationRelativePath: "nested/copy.txt" },
      { type: "delete", relativePath: "nested/copy.txt", confirm: true },
      { type: "mkdir", relativePath: "existing-dir", recursive: true },
      { type: "mkdir", relativePath: "existing-dir", recursive: true }
    ], false, false, "ordered"));
    assertBatchCountInvariant(batch);
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.operationStatus), ["applied", "applied", "applied", "no_change"]);
    assert.equal(batch.appliedCount, 3);
    assert.equal(batch.noChangeCount, 1);
    assert.equal(batch.batchOutcome, "succeeded");
    assert.equal(existsSync(path.join(projectRoot, "nested/copy.txt")), false);
    assert.equal(existsSync(path.join(projectRoot, "existing-dir")), true);
  });
});
