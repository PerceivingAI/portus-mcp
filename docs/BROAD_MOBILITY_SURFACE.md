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
| `project_context` | Alias-only discovery with `include.projects=true` and no `projectAlias`; with an alias, bounded status, tree, file-list, path metadata/existence, and package-script context. Project-scoped sections require `projectAlias`. |
| `project_read` | Ordered, bounded content, range, metadata, and existence requests. |
| `project_search` | File, text, symbol, or combined search. |
| `project_edit` | Ordered write, replace, insert, copy, move, delete, mkdir, and rmdir operations; batches are not atomic. |
| `project_patch` | Patch preparation or application, including preconditions and dry runs. |
| `project_run` | Approved checks, package scripts, or allowlisted commands. |
| `project_policy` | Ordered permission, path-decision, and safe effective-configuration checks, or one native registration, permission-update, or audit action. |

Broad schemas group related behavior without moving authority into the tool layer. `project_policy` requires exactly one of `checks` or `action`; `action` is a nested object selected by its inner `type` discriminator, as in `{ "action": { "type": "list_audit" } }`, not a flat string. Its action types are `register_project` (`projectPolicy` plus `registerProjects`), `update_permissions` (`projectPolicy` plus `updatePermissions`), and `list_audit` or `read_audit` (`projectPolicy`). Canonical paths, confirmation, safe projections, strict schemas, and redacted audit behavior remain authoritative; new administrative audit records use `tool=project_policy` and identify the action type in `operation`.

## Profiles

| Profile | Exposed groups |
|---|---|
| `broad` (default) | Exactly the seven broad project adapters. |
| `agent` | Agent and session registrations plus the shared `project_read` capability. |
| `full` | The seven broad project adapters plus agent and session registrations. |

There is no management or legacy profile. No obsolete project/admin or skill-specific name is registered under any profile, and there are no aliases, wrappers, deprecated paths, or compatibility registrations. Connected-agent skills reuse `project_read`; no separate skill group exists. Operator-owned configuration, environment pre-registration, and direct state/filesystem administration remain outside the model-facing MCP surface; retained model-accessible administration exists only as native `project_policy` actions.

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

A client with no prior alias knowledge calls `project_context` with `include.projects=true` and omits `projectAlias`. The response contains registered aliases only, never absolute roots or registry metadata. The client selects an alias, inspects it through project-scoped `project_context`, then reuses it with the other project tools. Any request that includes a project-scoped context section still requires `projectAlias`.


## Agent, Session, and Skill Boundary

Agent and session lifecycle operations remain outside the default `broad` profile, but the `project_read` adapter is shared with `agent` because it also provides bounded connected-agent skill reads. Skill availability is configuration, not a tool group: startup publishes metadata for `AGENT_SKILL_PATHS`, and `project_read` resolves only those skills through reserved `skill/<name>` aliases. Spawned-agent catalogs and read-only mounts come independently from `SUBAGENTS_SKILL_PATHS`. No skill-specific run, read, activation, or management tools remain.

## Testing Requirements

The hard cutover is accepted only when tests prove observable behavior, not source-text plumbing:

- default discovery returns exactly the seven broad tools;
- each broad schema is strict and rejects unknown or bypass-looking fields;
- every removed name is absent from discovery and current registrations;
- agent and full profiles expose only their defined groups;
- normal context, read, search, edit, patch, run, and policy workflows work end to end;
- ordered batches, per-item failures, dry runs, preconditions, and mode-dependent validation behave as documented;
- permissions, confirmations, Git-ignore handling, root confinement, blocked paths, limits, Unicode accounting, and audit semantics are preserved or strengthened;
- path traversal, shell escape, command-policy bypass, malformed input, and permission denial fail safely;
- errors and results do not leak absolute local paths or secrets; and
- agent and full profiles expose only their defined agent/session groups plus the shared read adapter, and skill-specific names remain absent.
