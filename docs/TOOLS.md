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
| `project_context` | With `include.projects=true` and no `projectAlias`, discover registered aliases only. With a `projectAlias`, retrieve bounded project status, tree, file-list, path metadata/existence, and package-script sections. Any project-scoped section requires `projectAlias`; the tool never returns file contents. |
| `project_read` | Submit 1–20 ordered content, binary, line-range, metadata, or existence requests. Per-item runtime failures are isolated. Resolves configured connected-agent skills through reserved `skill/<name>` aliases. |
| `project_search` | Search files, text, symbols, or all supported modes with server-bounded results and scanning. JavaScript regex matching runs in an isolated worker with a generous policy-owned execution budget. |
| `project_edit` | Run ordered write, replace, insert, copy, move, delete, mkdir, or rmdir operations, optionally as a dry run. The batch is ordered but not atomic. |
| `project_patch` | Prepare or apply a unified patch with policy checks, preconditions, dry-run behavior, and destructive confirmation where required. |
| `project_run` | Run approved checks, package scripts, or allowlisted commands without shell command-string parsing. |
| `project_policy` | Perform ordered permission, path-decision, and safe effective-configuration checks, or exactly one native administrative action: `register_project`, `update_permissions`, `list_audit`, or `read_audit`. |
| `subagent_task` | Subagent lifecycle management using discriminated action union (`start`, `stop`, `cleanup`). Accepts ordered batch actions and returns ordered results. |
| `subagent_context` | Batch read subagent execution status, events, stdout/stderr logs, and collected result artifacts. |

Connected-agent skill metadata is delivered through MCP server instructions; selected files are read through `project_read`.

## Project Discovery and Policy Actions

For cold start, call `project_context` with `include.projects=true` and omit `projectAlias`. The response is a safe inventory of registered aliases only: it contains no absolute roots, timestamps, environment values, or registry-storage details. After choosing an alias, pass it as `projectAlias` to inspect project-scoped context or use another project tool. Combining alias discovery with project-scoped context requires `projectAlias`.

`project_policy` accepts exactly one of `checks` or `action` per call. `action` is an object whose strict inner discriminator is `type`, for example `{ "action": { "type": "list_audit" } }`; it is never a flat action string. Its native action types are:

| Action | Capability | Required permission |
|---|---|---|
| `register_project` | Register a project using the strict registration schema. | `projectPolicy`. |
| `update_permissions` | Update the strict supported permission set. | `projectPolicy`. |
| `list_audit` | Return a bounded, safely projected audit listing. | `projectPolicy`. |
| `read_audit` | Read one safely projected audit record. | `projectPolicy`. |
These actions preserve canonical project-root handling, confirmation requirements, redacted audit projections, strict schemas, and safe errors. New administrative audit records identify `project_policy` as the tool and the native action as the operation. Operator configuration, environment pre-registration, and filesystem/state administration remain operator-only; the four actions above are the complete model-accessible management surface.

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

Callers cannot increase server maxima or override path, Git-ignore, permission, binary-file, confirmation, or audit policy. Text limits use Unicode code-point accounting. Ordinary reads, project-scoped context, search, policy checks, audit reads, and patch preparation remain unaudited; mutation, execution, registration, and permission updates retain audit guarantees. Results and errors do not disclose absolute project roots, secrets, command environments, or file contents as metadata.


## Subagent Tool Consolidation

Subagent execution, context, lifecycle, and cleanup are managed via `subagent_task` and `subagent_context`. Sessions remain internal runtime records used for asynchronous execution, queueing, retries, logs, process control, and cleanup, and do not exist as a separate MCP tool family.
## Verification Contract

Surface tests must establish that default discovery is exactly seven tools, obsolete names are absent, profile inventories are isolated, schemas reject unknown or bypass-looking fields, and broad workflows preserve permission, path, Git-ignore, confirmation, limit, audit, ordering, and safe-error behavior. Security regressions must cover traversal, blocked and ignored paths, command escape, permission denial, destructive confirmation, output bounds, Unicode accounting, and absolute-path or secret leakage.

See `docs/BROAD_MOBILITY_SURFACE.md` for the architecture decision and full cutover rationale.
