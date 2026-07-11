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
| `project_context` | Retrieve bounded project status, tree, file-list, path metadata/existence, and package-script sections. It never returns file contents. |
| `project_read` | Submit 1–20 ordered content, line-range, metadata, or existence requests. Per-item runtime failures are isolated. |
| `project_search` | Search files, text, symbols, or all supported modes with server-bounded results and scanning. JavaScript regex matching runs in an isolated worker with a generous policy-owned execution budget, preserving full regex behavior without blocking the MCP event loop. |
| `project_edit` | Run ordered write, replace, insert, copy, move, delete, mkdir, or rmdir operations, optionally as a dry run. The batch is ordered but not atomic. |
| `project_patch` | Prepare or apply a unified patch with policy checks, preconditions, dry-run behavior, and destructive confirmation where required. |
| `project_run` | Run approved checks, package scripts, or allowlisted commands without shell command-string parsing. |
| `project_policy` | Perform ordered, read-only permission, path-decision, and safe effective-configuration checks. It cannot mutate permissions or read audit data. |

Discovery annotations describe each tool's maximum capability. `project_edit` and `project_patch` are conservatively advertised as mutating/destructive even when a particular mode is read-only or dry-run.

## Non-Default Profiles

| Profile | Available surface |
|---|---|
| `broad` | Exactly the seven broad tools above. This is the default. |
| `management` | `project_register`, `project_list`, `permission_update`, `audit_list`, and `audit_read` only. |
| `agent` | Existing agent, session, and skill tools only. |
| `full` | All tools that remain after the hard cutover. |

Registration and registry enumeration are management operations rather than ordinary project mobility. Permission mutation and audit inspection remain admin/debug operations. Agent/session/skill tools are also non-default and behaviorally unchanged.

There is no `legacy` profile and no profile resurrects a replaced name.

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

Callers cannot increase server maxima or override path, Git-ignore, permission, binary-file, confirmation, or audit policy. Text limits use Unicode code-point accounting. Read, context, search, policy inspection, and patch preparation remain unaudited; mutation and execution retain audit guarantees. Results and errors do not disclose absolute project roots, secrets, command environments, or file contents as metadata.

## Migration From Removed Names

Names in this table are retired identifiers, not callable tools.

| Removed tools | Current operation |
|---|---|
| `project_read_file`, `project_read_text_file`, `project_read_file_range`, `project_read_files` | `project_read.requests[]` |
| `project_status`, `project_tree`, `project_list_files`, `project_file_info`, `project_exists`, `project_list_scripts` | `project_context.include` |
| `project_search_files`, `project_search_text`, `project_search_symbols` | `project_search.mode` |
| `project_prepare_patch`, `project_apply_patch` | `project_patch.mode` |
| `project_run_checks`, `project_run_script`, `project_run_command` | `project_run.type` |
| `project_write_file`, `project_replace_text`, `project_insert_text`, `project_copy_file`, `project_move_file`, `project_delete_file`, `project_create_directory`, `project_delete_directory` | `project_edit.operations[]` |
| `policy_check_path`, `policy_explain_permissions`, `permission_get`, `effective_config_show`, `config_show_safe` | `project_policy.checks[]` |

There is no alias window. Clients, examples, and tests migrate in the same release as registration removal.

## Agent, Session, and Skill Exclusion

The broad refactor does not redesign agent, session, skill, subagent, provider-selection, retry, lifecycle, cleanup, template, or orchestration behavior. Selecting `agent` or `full` exposes those existing registrations unchanged; the default `broad` profile does not expose them.

## Verification Contract

Surface tests must establish that default discovery is exactly seven tools, retired names are absent, profile inventories are isolated, schemas reject unknown or bypass-looking fields, and broad workflows preserve permission, path, Git-ignore, confirmation, limit, audit, ordering, and safe-error behavior. Security regressions must cover traversal, blocked and ignored paths, command escape, permission denial, destructive confirmation, output bounds, Unicode accounting, and absolute-path or secret leakage.

See `docs/BROAD_MOBILITY_SURFACE.md` for the architecture decision and full cutover rationale.
