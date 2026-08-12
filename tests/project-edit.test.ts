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
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      projectPatch: false,
      projectRun: false,
      projectPolicy: true,
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
    process: { maxOutputBufferMb: 10, maxBatchOutputChars: 1000000 }
  },
  audit: { strictMode: false }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";

after(() => rmSync(root, { recursive: true, force: true }));

// The server reads these environment-selected paths during module initialization.
const { createHttpServer } = await import("../src/server.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
upsertProject({ projectAlias: "edit", rootPath: projectRoot });

function resultOf(response: CallToolResult): Record<string, any> {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  assert(response.structuredContent && typeof response.structuredContent === "object" && "result" in response.structuredContent);
  return response.structuredContent.result as Record<string, any>;
}

async function callEdit(client: Client, operations: Array<Record<string, unknown>>, dryRun = false, continueOnFailure = false): Promise<CallToolResult> {
  return client.callTool({ name: "project_edit", arguments: { projectAlias: "edit", operations, dryRun, continueOnFailure } });
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
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

  await t.test("hard-cuts over exact edit and range input schemas", async () => {
    writeFileSync(path.join(projectRoot, "schema.txt"), "marker\n", "utf8");
    const missingExpected = await callEdit(client, [{ type: "replace", relativePath: "schema.txt", search: "marker", replace: "updated" }]);
    assert.equal(missingExpected.isError, true);
    const zeroExpected = await callEdit(client, [{ type: "replace", relativePath: "schema.txt", search: "marker", replace: "updated", expectedOccurrences: 0 }]);
    assert.equal(zeroExpected.isError, true);
    const retiredInsertMultiplicity = await callEdit(client, [{ type: "insert", relativePath: "schema.txt", marker: "marker", content: "before-", position: "before", expectedOccurrences: 1 }]);
    assert.equal(retiredInsertMultiplicity.isError, true);
    const missingRangeHash = await callEdit(client, [{ type: "replace_range", relativePath: "schema.txt", startLine: 1, endLine: 1, replacement: "updated" }]);
    assert.equal(missingRangeHash.isError, true);
    const invalidRangeBound = await callEdit(client, [{ type: "replace_range", relativePath: "schema.txt", expectedSha256: sha256("marker\n"), startLine: 0, endLine: 1, replacement: "updated" }]);
    assert.equal(invalidRangeBound.isError, true);
    assert.equal(readFileSync(path.join(projectRoot, "schema.txt"), "utf8"), "marker\n");
  });

  await t.test("reports zero matches as a completed rejection without touching the file", async () => {
    const target = path.join(projectRoot, "missing-match.txt");
    writeFileSync(target, "unchanged\n", "utf8");
    const before = statSync(target).mtimeMs;
    const batch = resultOf(await callEdit(client, [{ type: "replace", relativePath: "missing-match.txt", search: "absent", replace: "new", expectedOccurrences: 1 }]));
    assert.deepEqual({
      batchMode: batch.batchMode,
      batchOutcome: batch.batchOutcome,
      repositoryState: batch.repositoryState,
      successCount: batch.successCount,
      failedCount: batch.failedCount,
      errorCount: batch.errorCount,
      appliedCount: batch.appliedCount
    }, {
      batchMode: "ordered",
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
    assert.equal(readFileSync(target, "utf8"), "🙂x done\ndone\n");
  });
  await t.test("uses non-overlapping matches and preserves CRLF insertion placement", async () => {
    const target = path.join(projectRoot, "non-overlap-crlf.txt");
    writeFileSync(target, "aaa\r\nmarker\r\n", "utf8");
    const replacement = resultOf(await callEdit(client, [{ type: "replace", relativePath: "non-overlap-crlf.txt", search: "aa", replace: "X", expectedOccurrences: 1 }]));
    assert.deepEqual(replacement.results[0].exactMatchLocations, [{ line: 1, column: 1 }]);
    assert.equal("occurrences" in replacement.results[0], false);
    const insertion = resultOf(await callEdit(client, [{ type: "insert", relativePath: "non-overlap-crlf.txt", marker: "marker", content: "!", position: "after" }]));
    assert.deepEqual(insertion.results[0].exactMatchLocations, [{ line: 2, column: 1 }]);
    assert.equal(insertion.results[0].matchesApplied, 1);
    assert.equal(readFileSync(target, "utf8"), "Xa\r\nmarker!\r\n");
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
  });

  await t.test("distinguishes dry-run plans from applied mutations", async () => {
    const target = path.join(projectRoot, "dry-run.txt");
    writeFileSync(target, "marker\n", "utf8");
    const batch = resultOf(await callEdit(client, [{ type: "insert", relativePath: "dry-run.txt", marker: "marker", content: "before-", position: "before" }], true));
    assert.equal(batch.batchOutcome, "planned");
    assert.equal(batch.plannedCount, 1);
    assert.equal(batch.appliedCount, 0);
    assert.equal(batch.repositoryState, "unchanged");
    assert.equal(batch.results[0].operationStatus, "planned");
    assert.equal(batch.results[0].matchesPlanned, 1);
    assert.equal(batch.results[0].matchesApplied, 0);
    assert.equal(batch.results[0].fileChanged, false);
    assert.equal(readFileSync(target, "utf8"), "marker\n");
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


  await t.test("summarizes ordered partial mutation accurately", async () => {
    const created = path.join(projectRoot, "partial.txt");
    const batch = resultOf(await callEdit(client, [
      { type: "write", relativePath: "partial.txt", content: "created\n" },
      { type: "replace", relativePath: "partial.txt", search: "absent", replace: "updated", expectedOccurrences: 1 }
    ]));
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
    ]));
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
    ], false, true));
    assert.equal(batch.batchOutcome, "partial");
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.appliedCount, 1);
    assert.equal(batch.skippedCount, 0);
    assert.equal(batch.repositoryState, "partially_changed");
    assert.equal(readFileSync(continuedTarget, "utf8"), "written\n");
  });


  await t.test("uses typed results for ordered filesystem operations", async () => {
    writeFileSync(path.join(projectRoot, "copy-source.txt"), "copy\n", "utf8");
    const batch = resultOf(await callEdit(client, [
      { type: "copy", sourceRelativePath: "copy-source.txt", destinationRelativePath: "nested/copy.txt" },
      { type: "delete", relativePath: "nested/copy.txt", confirm: true },
      { type: "mkdir", relativePath: "existing-dir", recursive: true },
      { type: "mkdir", relativePath: "existing-dir", recursive: true }
    ]));
    assert.deepEqual(batch.results.map((result: Record<string, unknown>) => result.operationStatus), ["applied", "applied", "applied", "no_change"]);
    assert.equal(batch.appliedCount, 3);
    assert.equal(batch.noChangeCount, 1);
    assert.equal(batch.batchOutcome, "succeeded");
    assert.equal(existsSync(path.join(projectRoot, "nested/copy.txt")), false);
    assert.equal(existsSync(path.join(projectRoot, "existing-dir")), true);
  });
});
