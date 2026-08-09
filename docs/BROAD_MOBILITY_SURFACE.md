# Broad Mobility Surface

## Decision

Portus MCP treats **the connection as the product** and tools as policy-bounded adapters over that connection. A client connects to a registered machine and project, then performs ordinary project work through nine consolidated adapters instead of negotiating a growing collection of micro-tools.


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
The adapters divide work by intent:

| Adapter | Responsibility |
|---|---|
| `project_context` | Alias-only discovery with `include.projects=true` and no `projectAlias`; with an alias, effective execution capabilities plus bounded status, tree, file-list, path metadata/existence, and package-script context. The default scoped response includes execution; project-scoped sections require `projectAlias`. |
| `project_read` | Ordered, bounded content, range, metadata, and existence requests. |
| `project_search` | File, text, symbol, or combined search. |
| `project_edit` | Ordered write, replace, insert, copy, move, delete, mkdir, and rmdir operations; batches are not atomic. |
| `project_patch` | Patch preparation or application, including preconditions and dry runs. |
| `project_run` | Approved checks, package scripts, or allowlisted device-installed commands. |
| `project_policy` | Ordered permission, path-decision, and safe effective-configuration checks, or one native registration, permission-update, or audit action. |
| `subagent_task` | Subagent lifecycle management using discriminated action union (`start`, `stop`, `cleanup`). |
| `subagent_context` | Batch read subagent status, events, stdout/stderr logs, and collected results. |

Broad schemas group related behavior without moving authority into the tool layer. `project_policy` requires exactly one of `checks` or `action`; `action` is a nested object selected by its inner `type` discriminator, as in `{ "action": { "type": "list_audit" } }`, not a flat string. Its native actions (`register_project`, `update_permissions`, `list_audit`, `read_audit`) require `projectPolicy`. `subagent_task` and `subagent_context` require `subagentTask`. Canonical paths, confirmation, safe projections, strict schemas, and redacted audit behavior remain authoritative; new administrative audit records use `tool=project_policy` and identify the action type in `operation`.

## Subagent & Policy Unification

Subagent execution, context, lifecycle, and cleanup are managed through `subagent_task` and `subagent_context`. Sessions remain internal runtime records used for asynchronous execution, queueing, retries, logs, process control, and cleanup, and do not exist as a separate MCP tool family.
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

## Cold-Start Discovery

A client with no prior alias knowledge calls `project_context` with `include.projects=true` and omits `projectAlias`. The response contains registered aliases only, never absolute roots, registry metadata, or command policy. The client selects an alias and calls scoped `project_context`; the default response includes effective `enabled`, `allowedCommands`, `useShell`, and `requireConfirmation` execution values before the client uses `project_run`. Effective execution discovery requires `projectContext`, not administrative `projectPolicy`. Any request that includes another project-scoped context section still requires `projectAlias`.


## Subagent and Skill Boundaries

Subagent lifecycle operations are consolidated into `subagent_task` and `subagent_context`. Skill availability is configuration, not a tool group: startup publishes metadata for `AGENT_SKILL_PATHS`, and `project_read` resolves only those skills through reserved `skill/<name>` aliases. Spawned-subagent catalogs and read-only mounts come independently from `SUBAGENTS_SKILL_PATHS`. No skill-specific run, read, activation, or management tools remain.
## Testing Requirements

The hard cutover is accepted only when tests prove observable behavior, not source-text plumbing:

- default discovery returns exactly the nine consolidated tools;
- each broad schema is strict and rejects unknown or bypass-looking fields;
- every removed name is absent from discovery and current registrations;
- normal context, read, search, edit, patch, run, policy, subagent task, and subagent context workflows work end to end;
- ordered batches, per-item failures, dry runs, preconditions, and mode-dependent validation behave as documented;
- permissions, confirmations, Git-ignore handling, root confinement, blocked paths, limits, Unicode accounting, and audit semantics are preserved or strengthened;
- path traversal, shell escape, command-policy bypass, malformed input, and permission denial fail safely; and
- errors and results do not leak absolute local paths or secrets.
