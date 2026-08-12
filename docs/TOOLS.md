# MCP Tools

Portus MCP treats the connection as the product and tools as policy-bounded adapters.

The exact names displayed by a client may include the MCP server name as a prefix.

## Fixed Nine-Tool Surface

Portus MCP exposes exactly nine tools:

```text
project_context
project_read
project_search
project_edit
project_patch
project_run
project_policy
subagent_task
subagent_context
```

| Tool | Use |
|---|---|
| `project_context` | With `include.projects=true` and no `projectAlias`, discover registered aliases only. With a `projectAlias`, retrieve effective execution capabilities, bounded project status, tree, file-list, path metadata/existence, and package-script sections. The default scoped response includes execution capability; any project-scoped section requires `projectAlias`. The tool never returns file contents. |
| `project_read` | Submit 1–20 ordered content, binary, line-range, metadata, or existence requests. Text-content results include the SHA-256 of the complete raw file, including when returned content is range-bounded or truncated. Per-item runtime failures are isolated. Resolves configured connected-agent skills through reserved `skill/<name>` aliases. |
| `project_search` | Submit 1–20 ordered search requests (`mode`: `files`, `text`, `symbols`, or `all`). Git-ignored paths are excluded by default. Per-request `includeGitIgnored: true` requires selected-policy `readGitIgnoredFiles` authorization; explicit traversal exclusions still apply. Supports per-request `expect` (`present` or `absent`) returning tri-state expectation (`met`: true, false, or null when inconclusive). Text and symbol regex queries execute in an isolated worker thread. Enforces aggregate batch match (`maxBatchMatches`) and output character (`maxBatchOutputChars`) limits with deterministic truncation and scan reasons (`max_batch_matches`, `max_batch_output_chars`, `max_results`, `regex_timeout`, `read_error`). |
| `project_edit` | Run policy-checked edit batches in staged mode by default. Staged mode accepts write, exact replace, unique-marker insert, and hash-guarded inclusive `replace_range`; captures each base path once; evaluates same-path operations against projected content; revalidates every base before committing; and physically writes each changed path once. Semantic rejection withholds otherwise valid changes as `batch_rejected`; an execution failure withholds them as `batch_failed`; audit-gate or commit failures use sanitized `batchError`. Use `batchMode: "ordered"` for copy, move, delete, mkdir, rmdir, or intentional immediate sequencing; only ordered mode accepts `continueOnFailure`. Ordered mode stops after the first non-success unless continuation is explicit. Every batch reports `batchOutcome`, `repositoryState`, and success, rejection, execution-error, applied, no-change, planned, and skipped counts; `requestedCount = successCount + failedCount + errorCount + skippedCount`. `replace` requires positive `expectedOccurrences`; `insert` requires one marker; `replace_range` requires the complete-file SHA-256 returned by `project_read` and uses one-based inclusive lines capped by `limits.textEdit.maxRangeLines`. Dry runs return projected results without mutation. Cross-file commits are journaled but are not atomic and are not rolled back. Each call attempts one safe audit record per requested operation and one batch-summary record; public audit reads expose statuses, safe relative paths, and counts without contents, match text, hashes, absolute paths, or raw filesystem errors. |
| `project_patch` | Prepare or apply a unified patch with policy checks, preconditions, dry-run behavior, and destructive confirmation where required. |
| `project_run` | Submit 1–10 ordered execution requests (`type`: `check`, `script`, or `command`). Direct command execution uses native argv process spawn by default, with `shell=true` explicitly required and policy-gated (`allowShell`) for shell syntax or Windows `.cmd`/`.bat` launchers. Preflights all items before starting execution. Enforces an exact aggregate batch deadline (`batchTimeoutSecs`) with `batchTimedOut`, an aggregate output budget (`maxBatchOutputChars`) with `batchOutputTruncated`, and ordered process outcomes (`exited`, `spawn_failed`, `timed_out`, `signaled`, `output_limit`). Public audit events project execution type (`check`, `script`, `command`) and name. |
| `project_policy` | Perform ordered permission, path-decision, and safe read-only effective-configuration checks, or exactly one native administrative action: `register_project`, `list_audit`, or `read_audit`. |
| `subagent_task` | Subagent lifecycle management using discriminated action union (`start`, `stop`, `cleanup`). Accepts ordered batch actions and returns ordered results. |
| `subagent_context` | Batch read subagent execution status, events, stdout/stderr logs, and collected result artifacts. |

Connected-agent skill metadata is delivered through MCP server instructions; selected files are read through `project_read`.

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

Every operation result has `index`, operation `type`, safe relative path fields, `ok`, `outcome`, and `operationStatus`. `operationStatus` is exactly one of `applied`, `no_change`, `planned`, `not_applied`, `failed`, or `skipped`; `outcome` distinguishes completed semantic decisions from execution failure and skipped execution. Rejections use typed `reason` values and exact edits return bounded match counts and one-based Unicode line/column locations. Range edits return old/new ranges and hashes, using `projectedNewRange` and `projectedSha256` during dry runs.

Every batch returns `batchMode`, `batchOutcome`, `repositoryState`, `dryRun`, all counters, optional sanitized `batchError`, and ordered `results`. `failedCount` counts completed semantic rejections, `errorCount` counts execution failures, and `skippedCount` counts unattempted or withheld operations. The primary counter invariant is:

```text
requestedCount = successCount + failedCount + errorCount + skippedCount
```

## Project Discovery and Policy Actions

For cold start, call `project_context` with `include.projects=true` and omit `projectAlias`. The response is a safe inventory of registered aliases only: it contains no absolute roots, timestamps, environment values, registry-storage details, or command policy. After choosing an alias, call scoped `project_context`; its default response includes `execution` with effective `enabled`, `allowedCommands`, `allowShell`, and `requireConfirmation` values before the client uses `project_run`. Combining alias discovery with project-scoped context requires `projectAlias`.

`project_policy` accepts exactly one of `checks` or `action` per call. `action` is an object whose strict inner discriminator is `type`, for example `{ "action": { "type": "list_audit" } }`; it is never a flat action string. Its native action types are:

| Action | Capability | Required permission |
|---|---|---|
| `register_project` | Register a project using the strict registration schema. | `projectPolicy`. |
| `list_audit` | Return a bounded, safely projected audit listing. | `projectPolicy`. |
| `read_audit` | Read safely projected audit records selected by event or session ID. | `projectPolicy`. |

The read-only `config` check reports `permissionSource: "operator_policy"`, `policySelection: "shipped" | "configured"`, effective permissions, and redacted path/traversal patterns without exposing the selected absolute policy path. These actions preserve canonical project-root handling, redacted audit projections, strict schemas, and safe errors. Operator configuration, policy editing, environment pre-registration, and filesystem/state administration remain operator-only. No MCP action accepts permission changes.

Execution-capability discovery requires `projectContext`, not `projectPolicy`, so a client allowed to inspect and run a project can discover its effective command boundary without administrative policy access. `allowedCommands` means permitted to attempt through `project_run`, not verified installed. Skill `rootAlias` values do not support execution context.

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

Callers cannot increase server maxima or override path policy, permission, binary-file, confirmation, or audit policy. Ignored search scope is the deliberate exception to default exclusion: `includeGitIgnored: true` requires the selected policy to authorize it and does not override traversal exclusions. Text limits use Unicode code-point accounting. Ordinary reads, project-scoped context, search, policy checks, audit reads, and patch preparation remain unaudited; mutation, execution, and registration retain audit guarantees. Results and errors do not disclose absolute project roots, policy-file paths, secrets, command environments, or file contents as metadata.

The shipped direct-agent allowlist contains only `git`. Operators explicitly grant other device executables in `main_agent.permissions.allowedCommands`; spawned subagents use a separate allowlist. Shells and interpreters carry the authority of the Portus OS account and are not hard filesystem sandboxes.


## Subagent Tool Consolidation

Subagent execution, context, lifecycle, and cleanup are managed via `subagent_task` and `subagent_context`. Sessions remain internal runtime records used for asynchronous execution, queueing, retries, logs, process control, and cleanup, and do not exist as a separate MCP tool family.
## Verification Contract

Surface tests must establish that default discovery is exactly nine tools, obsolete names are absent, schemas reject unknown or bypass-looking fields, and broad workflows preserve permission, path, Git-ignore, confirmation, limit, audit, ordering, and safe-error behavior. Security regressions must cover traversal, blocked and ignored paths, command escape, permission denial, destructive confirmation, output bounds, Unicode accounting, and absolute-path or secret leakage.

See `docs/BROAD_MOBILITY_SURFACE.md` for the architecture decision and full cutover rationale.
