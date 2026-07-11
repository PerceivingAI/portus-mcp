# MCP Tools

Portus MCP treats the connection as the product and tools as policy-bounded adapters. Patch 3 ended direct micro-tool expansion. The current release is a breaking hard cutover: replaced tool names are removed, not wrapped, aliased, deprecated, or hidden in a legacy profile.

The exact names displayed by a client may include the MCP server name as a prefix.

## Default `broad` Profile

The default profile exposes exactly seven tools:

```text
project_context
project_read
project_search
project_edit
project_patch
project_run
project_policy
```

| Tool | Use |
|---|---|
| `project_context` | With `include.projects=true` and no `projectAlias`, discover registered aliases only. With a `projectAlias`, retrieve bounded project status, tree, file-list, path metadata/existence, and package-script sections. Any project-scoped section requires `projectAlias`; the tool never returns file contents. |
| `project_read` | Submit 1–20 ordered content, line-range, metadata, or existence requests. Per-item runtime failures are isolated. |
| `project_search` | Search files, text, symbols, or all supported modes with server-bounded results and scanning. JavaScript regex matching runs in an isolated worker with a generous policy-owned execution budget, preserving full regex behavior without blocking the MCP event loop. |
| `project_edit` | Run ordered write, replace, insert, copy, move, delete, mkdir, or rmdir operations, optionally as a dry run. The batch is ordered but not atomic. |
| `project_patch` | Prepare or apply a unified patch with policy checks, preconditions, dry-run behavior, and destructive confirmation where required. |
| `project_run` | Run approved checks, package scripts, or allowlisted commands without shell command-string parsing. |
| `project_policy` | Perform ordered permission, path-decision, and safe effective-configuration checks, or exactly one native administrative action: `register_project`, `update_permissions`, `list_audit`, or `read_audit`. |

Discovery annotations describe each tool's maximum capability. `project_edit` and `project_patch` are conservatively advertised as mutating/destructive even when a particular mode is read-only or dry-run.

## Non-Default Profiles

| Profile | Available surface |
|---|---|
| `broad` | Exactly the seven broad tools above. This is the default. |
| `agent` | Existing agent, session, and skill tools only. |
| `full` | The seven broad tools plus the unchanged agent, session, and skill tools. |

There is no management or legacy profile. No profile registers an obsolete project/admin name or exposes a compatibility path.

## Project Discovery and Policy Actions

For cold start, call `project_context` with `include.projects=true` and omit `projectAlias`. The response is a safe inventory of registered aliases only: it contains no absolute roots, timestamps, environment values, or registry-storage details. After choosing an alias, pass it as `projectAlias` to inspect project-scoped context or use another project tool. Combining alias discovery with project-scoped context requires `projectAlias`.

`project_policy` accepts exactly one of `checks` or `action` per call. `action` is an object whose strict inner discriminator is `type`, for example `{ "action": { "type": "list_audit" } }`; it is never a flat action string. Its native action types are:

| Action | Capability | Required permission |
|---|---|---|
| `register_project` | Register a project using the strict registration schema. | Both `projectPolicy` and `registerProjects`. |
| `update_permissions` | Update the strict supported permission set. | Both `projectPolicy` and `updatePermissions`. |
| `list_audit` | Return a bounded, safely projected audit listing. | `projectPolicy`. |
| `read_audit` | Read one safely projected audit record. | `projectPolicy`. |

These actions preserve canonical project-root handling, confirmation requirements, redacted audit projections, strict schemas, and safe errors. New administrative audit records identify `project_policy` as the tool and the native action as the operation. Operator configuration, environment pre-registration, and filesystem/state administration remain operator-only; the four actions above are the complete model-accessible management surface.

## Security and Policy

Every adapter remains bounded by:

- registered project-root confinement;
- blocked-path and traversal policy;
- Git-ignore read policy;
- the least existing permission required for each absorbed action;
- allowlisted command and package-script policy;
- server-owned request, input, output, scan, patch, line-range, edit, timeout, and process limits;
- confirmation for deletes, protected overwrites, patch deletions, and non-read-only execution as applicable;
- durable, redacted audit for mutation and execution; and
- safe errors and project-relative path reporting.

Callers cannot increase server maxima or override path, Git-ignore, permission, binary-file, confirmation, or audit policy. Text limits use Unicode code-point accounting. Ordinary reads, project-scoped context, search, policy checks, audit reads, and patch preparation remain unaudited; mutation, execution, registration, and permission updates retain audit guarantees. Results and errors do not disclose absolute project roots, secrets, command environments, or file contents as metadata.


## Agent, Session, and Skill Exclusion

The broad refactor does not redesign agent, session, skill, subagent, provider-selection, retry, lifecycle, cleanup, template, or orchestration behavior. Selecting `agent` or `full` exposes those existing registrations unchanged; the default `broad` profile does not expose them.

## Verification Contract

Surface tests must establish that default discovery is exactly seven tools, obsolete names are absent, profile inventories are isolated, schemas reject unknown or bypass-looking fields, and broad workflows preserve permission, path, Git-ignore, confirmation, limit, audit, ordering, and safe-error behavior. Security regressions must cover traversal, blocked and ignored paths, command escape, permission denial, destructive confirmation, output bounds, Unicode accounting, and absolute-path or secret leakage.

See `docs/BROAD_MOBILITY_SURFACE.md` for the architecture decision and full cutover rationale.
