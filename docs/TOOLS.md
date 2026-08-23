# MCP Tools

Portus MCP treats the connection as the product and tools as policy-bounded adapters.

The exact names displayed by a client may include the MCP server name as a prefix.

## Fixed Ten-Tool Surface

Portus MCP exposes exactly ten tools:

```text
project_context
project_read
project_search
project_edit
project_patch
project_run
project_policy
project_screenshot
subagent_task
subagent_context
```

| Tool | Use |
|---|---|
| `project_context` | With `include.projects=true` and no `projectAlias`, discover registered aliases only. With a `projectAlias`, retrieve the complete positive capability allowlist, bounded project status, tree, file-list, path metadata/existence, and package-script sections. The default scoped response includes `capabilities`; any project-scoped section requires `projectAlias`. The tool never returns file contents. |
| `project_read` | Submit 1–20 ordered content, binary, line-range, metadata, or existence requests. Text-content results include the SHA-256 of the complete raw file, including when returned content is range-bounded or truncated. Per-item runtime failures are isolated. Resolves configured connected-agent skills through reserved `skill/<name>` aliases. |
| `project_search` | Submit 1–20 ordered search requests (`mode`: `files`, `text`, `symbols`, or `all`). Git-ignored paths are excluded by default. Per-request `includeGitIgnored: true` requires selected-policy `readGitIgnoredFiles` authorization; explicit traversal exclusions still apply. Supports per-request `expect` (`present` or `absent`) returning tri-state expectation (`met`: true, false, or null when inconclusive). Text and symbol regex queries execute in an isolated worker thread. Enforces aggregate batch match (`maxBatchMatches`) and output character (`maxBatchOutputChars`) limits with deterministic truncation and scan reasons (`max_batch_matches`, `max_batch_output_chars`, `max_results`, `regex_timeout`, `read_error`). |
| `project_edit` | Run policy-checked edit batches in staged mode by default. Staged mode accepts write, exact replace, unique-marker insert, and hash-guarded inclusive `replace_range`; captures each base path once; evaluates same-path operations against projected content; revalidates every base before committing; and physically writes each changed path once. Semantic rejection withholds otherwise valid changes as `batch_rejected`; an execution failure withholds them as `batch_failed`; audit-gate or commit failures use sanitized `batchError`. Use `batchMode: "ordered"` for copy, move, delete, mkdir, rmdir, or intentional immediate sequencing; only ordered mode accepts `continueOnFailure`. Ordered mode stops after the first non-success unless continuation is explicit. Every batch reports `batchOutcome`, `repositoryState`, and success, rejection, execution-error, applied, no-change, planned, and skipped counts; `requestedCount = successCount + failedCount + errorCount + skippedCount`. `replace` requires positive `expectedOccurrences`; `insert` requires one marker; `replace_range` requires the complete-file SHA-256 returned by `project_read` and uses one-based inclusive lines capped by `limits.textEdit.maxRangeLines`. Dry runs return projected results without mutation. Cross-file commits are journaled but are not atomic and are not rolled back. Each call attempts one safe audit record per requested operation and one batch-summary record; public audit reads expose statuses, safe relative paths, and counts without contents, match text, hashes, absolute paths, or raw filesystem errors. |
| `project_patch` | Prepare or apply a unified patch or structured hunks with policy checks, preconditions, dry-run behavior, and destructive confirmation where required. |
| `project_run` | Submit 1–10 ordered execution requests (`type`: `check`, `script`, or `command`) or manage observable execution sessions (`sessionAction`: `start`, `poll`, `terminate`, `list`). Command execution authority is governed strictly by operator policy (`allowedCommands` and `allowShell`), automatically resolving Windows batch scripts (`.cmd`/`.bat`) through `cmd.exe /c` when `allowShell: true`. Preflights all items before starting execution. Enforces an aggregate execution deadline (`batchTimeoutSecs`) with `batchTimedOut`, an aggregate output budget (`maxBatchOutputChars`) with `batchOutputTruncated`, and ordered process outcomes (`exited`, `spawn_failed`, `timed_out`, `signaled`, `output_limit`). Timed-out items return bounded partial stdout/stderr plus deadline, elapsed-time, truncation, and explicit process lifecycle metadata. Public audit events project execution metadata. |
| `project_policy` | Perform ordered permission, path-decision, and safe read-only effective-configuration checks, or exactly one native administrative action: `list_audit` or `read_audit`. |
| `project_screenshot` | List or capture visible top-level windows owned by a running execution session or directly launched command, then read, list, or explicitly delete repository-local PNG/JPEG captures. Supports direct command launch-and-capture with auto-close (`closeSession: true`) or background retention (`closeSession: false`). |
| `subagent_task` | Subagent lifecycle management using discriminated action union (`start`, `stop`, `cleanup`). Accepts ordered batch actions and returns ordered results. |
| `subagent_context` | Batch read subagent execution status, events, stdout/stderr logs, and collected result artifacts. |

Connected-agent skill metadata is delivered through MCP server instructions; selected files are read through `project_read`.

### `project_run` Timeout and Output Contract

The public request fields `timeoutSecs` and `batchTimeoutSecs` are positive integer seconds. Executed results report `requestedTimeoutMs`, the request value or 120-second default, and `effectiveTimeoutMs`, the actual item deadline after clamping to the remaining batch budget. A timed-out result also reports `timeoutSource: "request" | "batch"`; a batch-clamped timeout sets top-level `batchTimedOut: true`.

Timeout is a normal executed item result: `ok: false`, `status: "executed"`, and `outcome: "timed_out"`. It is not an MCP tool error. `stdout` and `stderr` contain output captured before process close, subject to the same limits as every other outcome. The streams are independent and do not establish total cross-stream ordering.

Every executed process result includes `elapsedMs`, `stdoutTruncated`, `stderrTruncated`, and aggregate `truncated`. `elapsedMs` includes bounded process-tree termination and final stream drain, so it can be greater than `effectiveTimeoutMs`. Per-stream output limits apply before the aggregate batch output budget; batch limiting updates the affected stream flag and aggregate flag.

Every executed and skipped item result includes a deterministic `lifecycle` object with explicit command termination ownership booleans: `processStarted`, `processExited`, `killAttempted`, `killSucceeded`, `waitAttempted`, and `reaped`. When Portus initiates termination for `timed_out` or `output_limit`, `lifecycle` additionally includes `processTreeKillAttempted: true`, `processTreeKillSucceeded: true/false`, `descendantsRemaining: number`, `scope: "process_tree"`, the platform method (`process_group`, `taskkill_tree`, `win32_job_object`, or `descendant_fallback`), and optional `error`. `signal` is an observed child signal or `null`; Portus does not synthesize one from the requested termination method. A failed confirmation remains visible in `lifecycle.error` and `executionError`.

### `project_run` Observable Execution Sessions Contract

For long-running tasks (e.g. mathematical replays, large builds, tests), `project_run` supports asynchronous execution sessions via `sessionAction`:

1. **`start`**: `{ sessionAction: { type: "start", command: "python", args: ["script.py"], timeoutSecs: 3600, shell?: boolean, confirm?: boolean } }` spawns the command asynchronously in the background, allocates append-only stdout/stderr stream logs under the state directory, and returns `{ projectAlias, sessionAction: "start", session: { sessionId, status: "running", ... } }`.
2. **`poll`**: `{ sessionAction: { type: "poll", sessionId: "...", cursor?: number, maxChars?: number, stream?: "stdout" | "stderr" | "both" } }` returns `{ projectAlias, sessionAction: "poll", sessionId, status, stdoutChunk, nextCursor, exitCode, elapsedMs, lifecycle }`, allowing incremental progress observation without holding open a blocking tool invocation.
3. **`terminate`**: `{ sessionAction: { type: "terminate", sessionId: "..." } }` gracefully terminates and reaps the entire process tree for that session.
4. **`list`**: `{ sessionAction: { type: "list" } }` lists execution sessions for the project, newest first.

### `project_screenshot` contract

Enable the tool with `main_agent.permissions.projectScreenshot`. Every request uses a strict operation union and requires both `projectAlias` and `executionSessionId`. `targets` and `capture` require a running execution session whose live process identity can be attested; `read`, `list`, and `delete` remain available for persisted captures after the session exits. (`src/tools/projectScreenshot.ts:34-216`, `src/runtime/screenshotSystem.ts:620-1157`)

| Operation | Behavior |
|---|---|
| `targets` | Return only visible, non-minimized windows owned by the selected execution session. Results contain opaque, short-lived `windowId` tokens, never PIDs or native handles. |
| `capture` | Capture the sole eligible window or a selected `windowId`; save PNG or JPEG under `.portus-artifacts/screenshots/<executionSessionId>/`; return metadata and a native MCP image block unless `returnImage=false`. Requires `closeSession: boolean` to explicitly declare whether the session process tree is terminated immediately after capture. |
| `read` | Revalidate and return one managed screenshot from the same project/session, including a native image block unless `returnImage=false`. |
| `list` | Return newest-first managed screenshot metadata using bounded, opaque cursor pagination. It does not limit the number of stored screenshots. |
| `delete` | Explicitly remove one managed screenshot from the same project/session. No screenshot is deleted automatically. |

Capture requires `closeSession: boolean` (to auto-close the GUI/session or leave it running), and supports bounded `waitForWindowMs`, `format`, `jpegQuality`, `maxWidth`, and `maxHeight`. If several eligible windows exist and no `windowId` is supplied, the error is `multiple_session_windows` and includes scoped candidates. `capture` and `delete` require `confirm=true` when `main_agent.permissions.requireConfirmation=true`. Windows, macOS, and Linux X11 use the isolated npm-installed worker; Wayland fails closed with `unsupported_session_window_capture`. (`scripts/screenshot-worker.mjs:36-439`, `src/runtime/screenshotSystem.ts:322-1157`)

### `project_patch` Input and Result Contract

`project_patch` supports both raw unified diff strings and structured patch objects:

- **Raw Unified Diff**: `patch` is a string starting with standard diff headers (`diff --git`, `---`, `+++`).
- **Structured Patch**: `patch` is an object `{ files: StructuredPatchFile[] }` or array of file patches. Each file patch specifies `relativePath`, optional `expectedSha256`, and one of:
  - `hunks: Array<{ old: string, new: string, contextBefore?: string, contextAfter?: string, lineHint?: number }>` for targeted search-and-replace hunks;
  - `content: string` (with optional `newFile: true`) for full file creations or replacements;
  - `deleted: true` for file deletions.

In `mode: "prepare"`, Portus parses and validates the patch against project files, calculates `expectedFiles` with current SHA-256 hashes and modification timestamps, and returns `readyForApply: true`.

In `mode: "apply"`, Portus supports two safe application workflows:
- **One-Shot Direct Apply**: When `files[].expectedSha256` is provided inside the structured patch, top-level `expectedFiles` can be omitted; Portus automatically hydrates the expected metadata and enforces base-hash verification.
- **Seamless Two-Phase Piping**: When using `mode: "prepare"` first, the returned `expectedFiles` array can be passed directly to `mode: "apply"` without manual field filtering.

Portus verifies `expectedFiles` preconditions (rejecting stale files with `stale_file:<path>`), applies the changeset atomically via `git apply --check` and `git apply`, records durable audit logs, and returns `{ projectAlias, mode, applied, dryRun, changedFiles, deletedFiles }`.

### `project_edit` Input and Result Contract

The top-level input is strict:

| Field | Contract |
|---|---|
| `projectAlias` | Required registered project alias. `skill/<name>` aliases are read-only and cannot be edited. |
| `operations` | Required ordered array of 1–50 operations. |
| `batchMode` | `"staged"` by default; `"ordered"` is an explicit opt-in. |
| `dryRun` | Defaults to `false`. Reports projected operation results without filesystem mutation when `true`. |
| `continueOnFailure` | Defaults to `false`; valid only with `batchMode: "ordered"`. |

Operation inputs are also strict:

| Type | Fields |
|---|---|
| `write` | `relativePath`, `content`, optional complete-file `expectedSha256`. |
| `replace` | `relativePath`, non-empty `search`, `replace`, required positive `expectedOccurrences`, optional complete-file `expectedSha256`. Applies only when the non-overlapping exact-match count equals `expectedOccurrences`. |
| `insert` | `relativePath`, non-empty `marker`, `content`, `position: "before" \| "after"`, optional complete-file `expectedSha256`. Applies only when the marker occurs exactly once. |
| `replace_range` | `relativePath`, required complete-file `expectedSha256`, positive one-based inclusive `startLine` and `endLine`, and `replacement`. |
| `copy` | `sourceRelativePath`, `destinationRelativePath`, optional `overwrite` (default `false`). Ordered mode only. |
| `move` | `sourceRelativePath`, `destinationRelativePath`, optional `overwrite` (default `false`). Ordered mode only. |
| `delete` | `relativePath`, optional `confirm` (default `false`). Ordered mode only. |
| `mkdir` | `relativePath`, optional `recursive` (default `true`). Ordered mode only. |
| `rmdir` | `relativePath`, optional `recursive` and `confirm` (both default `false`). Ordered mode only. |

Staged evaluation continues after an operation-local semantic rejection or execution failure whenever the path's captured projection remains available. The failed operation leaves the last valid projected state unchanged, so later same-path operations are still checked in order. If the batch is rejected, valid mutations are withheld as `skipped/batch_rejected`; if staging has an execution failure, they are withheld as `skipped/batch_failed`. `skipped/prior_operation_failed` is reserved for operations that cannot be evaluated because their path projection is unavailable.

Every operation result has `index`, operation `type`, safe relative path fields, `ok`, `outcome`, and `operationStatus`. `operationStatus` is exactly one of `applied`, `no_change`, `planned`, `not_applied`, `failed`, or `skipped`; `outcome` distinguishes completed semantic decisions from execution failure and skipped execution. Exact edits return bounded match counts and one-based Unicode line/column locations. Range edits return old/new ranges and hashes, using `projectedNewRange` and `projectedSha256` during dry runs.

Rejected and skipped operations use this complete typed `reason` taxonomy:

| Reason | Contract |
|---|---|
| `occurrence_mismatch` | A replacement's exact-match count differs from `expectedOccurrences`, or an insertion marker is not unique. |
| `stale_file` | An operation's expected SHA-256 does not match the captured on-disk base, or pre-commit revalidation detects that the base changed. |
| `invalid_range` | A requested line range is reversed, outside the projected file, or wider than the configured limit. |
| `conflicting_base_hash` | A later staged operation supplies a different `expectedSha256` from the already accepted base guard for the same path. |
| `unsupported_batch_mode` | The selected batch mode does not support the requested operation. |
| `batch_rejected` | An otherwise valid staged mutation is withheld because the batch contains a semantic rejection. |
| `batch_failed` | An otherwise valid staged mutation is withheld because staging encountered an execution failure. |
| `prior_operation_failed` | The operation cannot be evaluated because its required path projection is unavailable. |

Execution failures use `outcome: "failed"`, `operationStatus: "failed"`, and a sanitized `error` rather than a `reason`. Human-readable diagnostics may supplement a typed reason but do not replace it.

Every batch returns `batchMode`, `batchOutcome`, `repositoryState`, `dryRun`, all counters, optional sanitized `batchError`, and ordered `results`. `failedCount` counts completed semantic rejections, `errorCount` counts execution failures, and `skippedCount` counts unattempted or withheld operations. The primary counter invariant is:

```text
requestedCount = successCount + failedCount + errorCount + skippedCount
```

## Project Discovery and Policy Actions

For cold start, call `project_context` with `include.projects=true` and omit `projectAlias`. The response is a safe inventory of registered aliases only: it contains no absolute roots, timestamps, environment values, registry-storage details, or command policy. After choosing an alias, call scoped `project_context`; its default response includes `capabilities`, status, tree, and scripts. Combining alias discovery with project-scoped context requires `projectAlias`.

`capabilities.complete: true` declares that `capabilities.availableTools` is the complete effective allowlist, not a sample. Keys are exact MCP tool names and every returned tool has `enabled: true`; a registered tool absent from this object is unavailable under the selected policy and should not be invoked. Registration remains fixed, so MCP `tools/list` can contain tools absent from this allowlist. `subagent_task` and `subagent_context` appear independently according to their dedicated `subagentTask` and `subagentContext` permissions. Runtime permission, path, command, confirmation, and validation checks remain authoritative.

Enabled planning details appear only where usable: `project_run.allowedCommands` is nested under an available `project_run`; `features.shell` requires both `projectRun` and `allowShell`; `features.readGitIgnoredFiles` requires its permission and an applicable available operation; and `features.protectedOperationsRequireConfirmation` requires confirmation policy plus an available edit, patch, or execution operation. Disabled tools and features are omitted—no capability entry uses `enabled: false`. `include.capabilities` is strict and project-only; skill root aliases reject it. The former `include.execution` input and `sections.execution` response were removed without an alias or compatibility path.

`project_policy` accepts exactly one of `checks` or `action` per call. `action` is an object whose strict inner discriminator is `type`, for example `{ "action": { "type": "list_audit" } }`; it is never a flat action string. Its native action types are:

| Action | Capability | Required permission |
|---|---|---|
| `list_audit` | Return a bounded, safely projected audit listing. | `projectPolicy`. |
| `read_audit` | Read safely projected audit records selected by event or session ID. | `projectPolicy`. |

The read-only `config` check reports `permissionSource: "operator_policy"`, `policySelection: "shipped" | "configured"`, effective permissions, and redacted path/traversal patterns without exposing the selected absolute policy path. These actions preserve canonical project-root handling, redacted audit projections, strict schemas, and safe errors. Operator configuration, policy editing, environment pre-registration, and filesystem/state administration remain operator-only. No MCP action accepts permission changes.

Capability discovery requires `projectContext`, not `projectPolicy`, so a client can inspect its positive effective authority without administrative policy access. `allowedCommands` means permitted to attempt through `project_run`, not verified installed. Skill `rootAlias` values do not support capability context.

## Security and Policy

Every adapter remains bounded by:

- registered project-root confinement;
- blocked-path and traversal policy;
- configured connected-agent skill-root confinement for `skill/<name>` reads;
- Git-ignore read policy;
- the least existing permission required for each absorbed action;
- allowlisted command and package-script policy;
- server-owned request, input, output, scan, patch, line-range, edit, timeout, and process limits;
- confirmation for deletes, protected overwrites, patch deletions, and non-read-only execution as applicable;
- durable, redacted audit for mutation and execution; and
- safe errors and project-relative path reporting.

Callers cannot increase server maxima or override path policy, permission, binary-file, confirmation, or audit policy. Ignored search scope is the deliberate exception to default exclusion: `includeGitIgnored: true` requires the selected policy to authorize it and does not override traversal exclusions. Text limits use Unicode code-point accounting. Ordinary reads, project-scoped context, search, policy checks, audit reads, and patch preparation remain unaudited; mutation and execution retain audit guarantees. Results and errors do not disclose absolute project roots, policy-file paths, secrets, command environments, or file contents as metadata.

The shipped direct-agent allowlist contains only `git`. Operators explicitly grant other device executables in `main_agent.permissions.allowedCommands`; spawned subagents use a separate allowlist. Shells and interpreters carry the authority of the Portus OS account and are not hard filesystem sandboxes.


## Subagent Tool Consolidation

Subagent execution, context, lifecycle, and cleanup are managed via `subagent_task` and `subagent_context`. `subagentTask` controls start, stop, and cleanup; `subagentContext` independently controls session listings, status, outputs, events, and capability inspection. Sessions remain internal runtime records used for asynchronous execution, queueing, retries, logs, process control, and cleanup, and do not exist as a separate MCP tool family.
## Verification Contract

Surface tests must establish that default discovery is exactly ten tools, obsolete names are absent, schemas reject unknown or bypass-looking fields, and broad workflows preserve permission, path, Git-ignore, confirmation, limit, audit, ordering, and safe-error behavior. Screenshot regressions additionally cover process ownership, unrelated-window exclusion, native image results, repository confinement, explicit-delete persistence, and platform capability behavior.

See `docs/BROAD_MOBILITY_SURFACE.md` for the architecture decision and full cutover rationale.

## Tool Registration & Schema Advertisement Contract

When registering tools on the MCP server (`server.registerTool` or `registerStrictProjectTool`), adhere to the following schema conventions to ensure full JSON Schema advertisement across all MCP clients:

### 1. Root Schema Must Be a `ZodObject`
`@modelcontextprotocol/sdk` normalizes `inputSchema` during `tools/list` by inspecting `schema.shape` (`normalizeObjectSchema()`).
- **Rule**: `inputSchema` passed to `server.registerTool` **MUST** be a top-level `z.object(shape).strict()` or a raw `ZodRawShape`.
- **Pitfall to Avoid**: **NEVER** pass top-level `z.discriminatedUnion()`, `z.union()`, or `z.object().superRefine()` directly as the registered `inputSchema`. These types lack a direct top-level `.shape` property, causing the SDK to fall back to `EMPTY_OBJECT_JSON_SCHEMA` (`{ "type": "object", "properties": {} }`), which renders in client frontends (such as ChatGPT) as `tool_name = () => any`.

### 2. Pattern for Multi-Operation / Discriminated Tools
For tools supporting multiple operations (like `project_screenshot` or discriminated action tools):

1. **Advertised Schema (for MCP Discovery)**:
   Define a comprehensive `ZodObject` shape containing all possible operation fields, with `operation: z.enum([...])` and explicit field `.describe(...)` annotations. Register this as `inputSchema`.

2. **Execution Schema (for Runtime Validation)**:
   Define a separate `z.discriminatedUnion("operation", [...])` enforcing per-operation required/prohibited fields and refinements.

3. **Handler Validation**:
   In the registered tool handler, validate incoming `args` against the discriminated schema before dispatching:
   ```typescript
   async (args): Promise<CallToolResult> => {
     try {
       const validated = discriminatedSchema.parse(args);
       return richToolSuccessResult(await execute(validated));
     } catch (error) {
       return richToolErrorResult(error);
     }
   }
   ```
