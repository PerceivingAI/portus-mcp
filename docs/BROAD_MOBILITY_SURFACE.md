# Broad Mobility Surface

## Decision

Portus MCP treats **the connection as the product** and tools as policy-bounded adapters over that connection. A client connects to a registered machine and project, then performs ordinary project work through seven broad adapters instead of negotiating a growing collection of micro-tools.

Patch 3 was the final direct micro-tool expansion. The broad surface is a breaking, hard cutover: replaced registrations, schemas, permission-map entries, examples, and tool-specific compatibility tests are removed. There are no aliases, wrappers, deprecated registrations, legacy profile, or resurrection path.

## Default Surface

The default `broad` profile exposes exactly:

```text
project_context
project_read
project_search
project_edit
project_patch
project_run
project_policy
```

The adapters divide work by intent:

| Adapter | Responsibility |
|---|---|
| `project_context` | Bounded status, tree, file-list, path metadata/existence, and package-script context. |
| `project_read` | Ordered, bounded content, range, metadata, and existence requests. |
| `project_search` | File, text, symbol, or combined search. |
| `project_edit` | Ordered write, replace, insert, copy, move, delete, mkdir, and rmdir operations; batches are not atomic. |
| `project_patch` | Patch preparation or application, including preconditions and dry runs. |
| `project_run` | Approved checks, package scripts, or allowlisted commands. |
| `project_policy` | Read-only permission, path-decision, and safe effective-configuration checks. |

Broad schemas group related behavior without moving authority into the tool layer. Registration remains thin; shared project services provide behavior; existing policy, runtime, registry, and state modules remain authoritative.

## Profiles

| Profile | Exposed groups |
|---|---|
| `broad` (default) | Exactly the seven broad project adapters. |
| `management` | `project_register`, `project_list`, `permission_update`, `audit_list`, and `audit_read`. No broad or agent tools. |
| `agent` | Existing agent, session, and skill registrations only. |
| `full` | Every tool that remains after the hard cutover: broad, management/admin, and unchanged agent/session/skill tools. |

Project registration, registry enumeration, permission mutation, and audit inspection remain available because no broad read-only adapter absorbs those administrative capabilities. They are deliberately non-default.

There is no `legacy` profile. Unknown or malformed profile configuration fails closed rather than silently selecting another surface.

## Security Model

Broad tools do not create caller-controlled bypasses. Safety remains layered:

1. connector, tunnel, MCP server, and process availability;
2. registered project roots and root confinement;
3. blocked-path, traversal, and Git-ignore policy;
4. least-existing permission gates for every absorbed action;
5. allowlisted commands and explicit executable/argument boundaries—never shell command parsing;
6. server-owned request, input, output, scan, line-range, patch, text-edit, timeout, and process limits;
7. confirmation for destructive or protected actions;
8. durable, redacted audit for mutations and execution;
9. operating-system permissions; and
10. strict schemas, deterministic ordering, and safe errors.

Caller-supplied bounds may narrow a server maximum but cannot raise it. Broad schemas do not expose ignore-policy, path-policy, permission, binary-read, or equivalent escape hatches. Results, errors, and audit metadata use project-relative paths or generic safe messages; they do not expose absolute roots, secrets, environment details, command environments, or file contents.

Read, search, context, policy inspection, and patch preparation are unaudited. Mutations and execution retain durable audit behavior. Mixed-capability tools advertise conservative annotations based on their maximum capability.

## Migration Map

The old names below are migration identifiers only; they are not available tools.

| Removed calls | Replacement |
|---|---|
| `project_read_file`, `project_read_text_file`, `project_read_file_range`, `project_read_files` | `project_read` request entries |
| `project_status`, `project_tree`, `project_list_files`, `project_file_info`, `project_exists`, `project_list_scripts` | `project_context.include` sections |
| `project_search_files`, `project_search_text`, `project_search_symbols` | `project_search.mode` |
| `project_prepare_patch`, `project_apply_patch` | `project_patch.mode` |
| `project_run_checks`, `project_run_script`, `project_run_command` | `project_run.type` |
| `project_write_file`, `project_replace_text`, `project_insert_text`, `project_copy_file`, `project_move_file`, `project_delete_file`, `project_create_directory`, `project_delete_directory` | `project_edit.operations[]` |
| `policy_check_path`, `policy_explain_permissions`, `permission_get`, `effective_config_show`, `config_show_safe` | `project_policy.checks[]` |

Clients must migrate in the same release. Name compatibility is intentionally not preserved; behavioral compatibility means retaining or strengthening the prior permission, path, Git-ignore, confirmation, limit, audit, safe-error, and result guarantees.

## Agent, Session, and Skill Boundary

This decision does not redesign, remove, expand, or behaviorally refactor agent, session, skill, subagent, provider-selection, retry, lifecycle, cleanup, template, or orchestration behavior. Profile-aware registration only controls whether those existing tools are visible. They remain unchanged and outside the default `broad` surface.

## Testing Requirements

The hard cutover is accepted only when tests prove observable behavior, not source-text plumbing:

- default discovery returns exactly the seven broad tools;
- each broad schema is strict and rejects unknown or bypass-looking fields;
- every removed name is absent from discovery and current registrations;
- management, agent, and full profiles expose only their defined groups;
- normal context, read, search, edit, patch, run, and policy workflows work end to end;
- ordered batches, per-item failures, dry runs, preconditions, and mode-dependent validation behave as documented;
- permissions, confirmations, Git-ignore handling, root confinement, blocked paths, limits, Unicode accounting, and audit semantics are preserved or strengthened;
- path traversal, shell escape, command-policy bypass, malformed input, and permission denial fail safely;
- errors and results do not leak absolute local paths or secrets; and
- existing agent/session/skill behavior remains unchanged when its profile is selected.
