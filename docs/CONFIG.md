# Configuration

## What This Document Covers

This document describes the active environment, application, tool-surface, and policy configuration. The broad-mobility release is a hard cutover: configuration selects among current profiles and cannot enable removed tools. (`src/config.ts:10-11`, `src/config.ts:70-82`)

## Overview

The connection is the product; tools are adapters whose availability is selected independently from the policy that bounds their behavior. Portus MCP uses three configuration surfaces:

```text
.env
portus-mcp.config.json
portus-mcp.policy.json
```

`.env` selects process, project, provider, and file locations. `portus-mcp.config.json` controls the tool surface and structured application behavior. `portus-mcp.policy.json` owns permissions and runtime limits. Unknown application-config keys and invalid profile values fail validation rather than being ignored. (`src/config.ts:70-103`, `src/policy/policyConfig.ts:99-102`)

## Tool-Surface Profile

`portus-mcp.config.json` accepts one `toolSurface` value. It defaults to `broad` when omitted. (`src/config.ts:10-11`, `src/config.ts:36-37`, `src/config.ts:70-82`)

| Value | Surface |
|---|---|
| `broad` | Default; exactly `project_context`, `project_read`, `project_search`, `project_edit`, `project_patch`, `project_run`, and `project_policy`. |
| `management` | Only `project_register`, `project_list`, `permission_update`, `audit_list`, and `audit_read`. |
| `agent` | Existing agent, session, and skill registrations only. |
| `full` | Every tool that remains after the hard cutover. |

Example:

```json
{
  "toolSurface": "broad",
  "agents": {
    "defaultTemplate": "ephemeral-project-agent",
    "retry": {
      "enabled": true,
      "maxAttempts": 3,
      "baseDelayMs": 1000,
      "maxDelayMs": 10000,
      "jitterRatio": 0.2,
      "retryOn": ["rate_limit", "timeout", "server_error"],
      "respectRetryAfter": true,
      "maxRetryWindowSecs": 120
    }
  },
  "traversal": { "excludedPatterns": [] },
  "skills": { "directory": "./skills" }
}
```

There is no `legacy` profile. A replaced name cannot be restored by configuration, compatibility wrapper, alias, or hidden registration. Agent/session/skill behavior is unchanged; profile selection only controls exposure. (`src/config.ts:10-11`, `src/config.ts:59-82`)

## Migration From Removed Tools

The following names are retired migration identifiers, not available tools. Clients must update in the same release; there is no alias window. (`src/config.ts:10-11`, `src/config.ts:70-82`)

| Removed tool family | Broad operation |
|---|---|
| `project_read_file`, `project_read_text_file`, `project_read_file_range`, `project_read_files` | `project_read.requests[]` |
| `project_status`, `project_tree`, `project_list_files`, `project_file_info`, `project_exists`, `project_list_scripts` | `project_context.include` |
| `project_search_files`, `project_search_text`, `project_search_symbols` | `project_search.mode` |
| `project_prepare_patch`, `project_apply_patch` | `project_patch.mode` |
| `project_run_checks`, `project_run_script`, `project_run_command` | `project_run.type` |
| `project_write_file`, `project_replace_text`, `project_insert_text`, `project_copy_file`, `project_move_file`, `project_delete_file`, `project_create_directory`, `project_delete_directory` | `project_edit.operations[]` |
| `policy_check_path`, `policy_explain_permissions`, `permission_get`, `effective_config_show`, `config_show_safe` | `project_policy.checks[]` |

## Environment Variables

Server and authentication variables:

```text
PORTUS_MCP_PORT=8789
PORTUS_MCP_PATH=/mcp
PORTUS_MCP_BEARER_TOKEN=
```

The port defaults to `8789`, the MCP route defaults to `/mcp`, and an empty bearer token disables static bearer authentication. (`src/server.ts:38-41`, `src/server.ts:167-171`)

Pre-register projects with semicolon-separated `alias=absolute/path` entries:

```text
PORTUS_MCP_PROJECTS=app=C:/path/to/app;api=C:/path/to/api
```

Malformed entries fail with an actionable error. (`src/state/ProjectRegistry.ts:48-63`)

Configuration and state locations:

```text
PORTUS_MCP_CONFIG_PATH=./portus-mcp.config.json
PORTUS_MCP_POLICY_PATH=./portus-mcp.policy.json
PORTUS_MCP_STATE_DIR=.portus-mcp
```

Those values resolve the application config, policy config, and durable state directory respectively. (`src/config.ts:84-93`, `src/policy/policyConfig.ts:99-102`, `src/state/StateStore.ts:8-12`)

Provider variables are needed only for non-default agent/session/skill work. `PORTUS_MCP_DEFAULT_PROVIDER` selects the provider; the selected provider determines its model and credential variables. The seven broad project tools do not need provider credentials. (`src/config.ts:106-109`)

## Application Configuration

Beyond `toolSurface`, `portus-mcp.config.json` contains the default agent template and retry policy, traversal exclusions, and skills directory. The schema is strict: retry counts and delays must be positive, jitter is between 0 and 1, retry reasons are non-empty strings, exclusions are non-empty strings, and the skills directory is non-empty. (`src/config.ts:36-57`, `src/config.ts:59-82`)

Agent/session/skill settings do not alter the seven broad adapters. They apply only when the `agent` or `full` surface exposes the unchanged agent group. (`src/config.ts:38-56`, `src/config.ts:70-82`)

## Policy Configuration

`portus-mcp.policy.json` controls grouped agent lifecycle/concurrency policy, seven broad-tool permissions, independent management/agent permissions, blocked paths, command and Git-ignore constraints, and server-owned limits. Each broad tool checks its matching permission once at entry; operation subtypes do not add authorization gates. (`src/config.ts:13-26`, `src/policy/policyConfig.ts:39-53`)

ChatGPT broad-tool permissions are:

```text
projectContext
projectRead
projectSearch
projectEdit
projectPatch
projectRun
projectPolicy
```

`registerProjects`, `updatePermissions`, and `spawnAgents` remain independent management/agent permissions. `readGitIgnoredFiles` and `allowedCommands` are internal constraints enforced inside relevant broad tools, not substitutes for their broad permission. `project_policy` is read-only and reports the matching broad permission for each requested broad operation. The strict policy and permission-update schemas reject obsolete operation-level fields. (`src/config.ts:13-26`, `src/tools/config.ts:13-70`)

Server policy owns file-read, file-write, patch, text-edit, search, skill, agent-output, session-event, audit, timeout, and process bounds. Caller bounds may narrow an authoritative maximum but cannot raise it; callers cannot override blocked paths, Git-ignore handling, permissions, confirmation, or audit. (`src/policy/policyConfig.ts:99-102`)

`limits.search.maxRegexExecutionMs` is the cumulative JavaScript-regex execution budget for one `project_search` section. The default is `120000` ms. Regex matching runs in a worker thread, so pathological backtracking cannot block other MCP work; expiration terminates the worker and returns `regex_search_timeout`. The budget covers regex execution rather than traversal or file I/O and should remain generous enough for legitimate remote model work.

Filesystem authorization uses the canonical registered project root, not lexical path prefixes alone. Registration canonicalizes root paths. Every target or nearest existing creation parent is resolved canonically before access, and mutation, patch, and command boundaries revalidate immediately before side effects. Symlinks and Windows junctions are supported when they resolve inside the same registered root; links that escape the root and broken links that cannot be resolved safely are rejected. Blocked-path policy applies to both the requested path and its canonical destination.

## Security and Audit Semantics

All project access remains confined to registered roots and subject to blocked-path and Git-ignore policy. Destructive or protected operations retain confirmation. Mutation and execution retain durable, redacted audit behavior; read, context, search, policy inspection, and patch preparation are unaudited. Safe projections and errors must not disclose absolute roots, bearer tokens, provider credentials, environment details, file contents, or command environments. (`src/config.ts:13-24`, `src/server.ts:38-41`, `src/state/StateStore.ts:8-12`)

Management operations are non-default so ordinary broad discovery does not expose project registration, permission mutation, or audit reads. Agent/session/skill tools are likewise non-default and remain behaviorally outside the broad refactor. (`src/config.ts:10-11`, `src/config.ts:70-82`)

## Defaults and Resolution

1. `PORTUS_MCP_CONFIG_PATH` selects the application JSON; otherwise `./portus-mcp.config.json` is used.
2. `toolSurface` defaults to `broad`; an unknown value or unknown application-config key fails closed.
3. `PORTUS_MCP_POLICY_PATH` selects policy JSON; otherwise `./portus-mcp.policy.json` is used.
4. `PORTUS_MCP_PROJECTS` adds pre-registered roots.
5. `PORTUS_MCP_STATE_DIR` selects durable local state; otherwise `.portus-mcp` is used.

Missing or invalid JSON configuration fails startup with file and validation details. (`src/config.ts:70-103`, `src/policy/policyConfig.ts:99-102`, `src/state/ProjectRegistry.ts:48-63`, `src/state/StateStore.ts:8-12`)

## Codebase References

- Tool-surface values and strict application schema: `src/config.ts:10-11`, `src/config.ts:59-103`
- Direct permission model: `src/config.ts:13-34`
- HTTP path, bearer token, and port: `src/server.ts:38-41`, `src/server.ts:167-171`
- Project pre-registration: `src/state/ProjectRegistry.ts:48-63`
- Policy path: `src/policy/policyConfig.ts:99-102`
- Durable state path: `src/state/StateStore.ts:8-12`
