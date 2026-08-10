# Configuration

## What This Document Covers

This document describes active environment, application, skill-source, and policy configuration. (`src/config.ts:11-24`, `src/server.ts:15-25`, `src/policy/policyConfig.ts:39-56`)

## Overview

The connection is the product; tools are adapters whose availability is selected independently from the policy that bounds their behavior. Portus MCP uses three configuration surfaces:

```text
.env
portus-mcp.config.json
portus-mcp.policy.json
```

`.env` selects process, project, provider, skill-source, and file locations. `portus-mcp.config.json` controls the tool surface and structured application behavior. `portus-mcp.policy.json` owns permissions and runtime limits. Unknown application-config keys and invalid profile values fail validation rather than being ignored. (`src/config.ts:71-102`, `src/skills/SkillRegistry.ts:203-212`, `src/policy/policyConfig.ts:99-102`)

## Tool Surface

Portus MCP exposes one fixed nine-tool surface:

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

Example `portus-mcp.config.json`:

```json
{
  "agents": {
    "defaultTemplate": "ephemeral-project-subagent",
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
  "traversal": { "excludedPatterns": [] }
}
```

## Environment Variables

Server and authentication variables:

```text
PORTUS_MCP_HOST=127.0.0.1
PORTUS_MCP_PORT=8789
PORTUS_MCP_PATH=/mcp
PORTUS_MCP_BEARER_TOKEN=
PORTUS_TUNNEL_CLIENT_PATH=
PORTUS_TUNNEL_PROFILE=portus-local
```

The host defaults to `127.0.0.1`, the port defaults to `8789`, the MCP route defaults to `/mcp`, and an empty bearer token disables static bearer authentication. `PORTUS_TUNNEL_CLIENT_PATH` and `PORTUS_TUNNEL_PROFILE` tune single-command launcher orchestration (`npm run start:tunnel`).

Pre-register projects with semicolon-separated `alias=absolute/path` entries:

```text
PORTUS_MCP_PROJECTS=app=C:/path/to/app;api=C:/path/to/api
```

Malformed entries and reserved `skill/` aliases fail with actionable errors. (`src/state/ProjectRegistry.ts:35-40`, `src/state/ProjectRegistry.ts:80-103`)

Configure connected-agent and spawned-subagent skill sources independently:

```text
AGENT_SKILL_PATHS=./skills
SUBAGENTS_SKILL_PATHS=./skills
```

Each value is a semicolon-separated list of skill directories or catalog directories whose immediate children are skills. Paths resolve relative to `PORTUS_MCP_CONFIG_PATH`. When a variable is unset, its audience uses `./skills` if that directory exists; an explicitly empty value disables that audience. Invalid paths and conflicting names fail startup. No user, system, or native-agent skill location is scanned implicitly. (`src/skills/SkillRegistry.ts:203-280`)

Configuration and state locations:

```text
PORTUS_MCP_CONFIG_PATH=./portus-mcp.config.json
PORTUS_MCP_POLICY_PATH=./portus-mcp.policy.json
PORTUS_MCP_STATE_DIR=.portus-mcp
```

Those values resolve the application config, policy config, and durable state directory respectively. (`src/config.ts:82-102`, `src/policy/policyConfig.ts:104-124`, `src/state/StateStore.ts:6-12`)

For a private command-policy override, copy the complete shipped `portus-mcp.policy.json` to the Git-ignored `portus-mcp.policy.local.json`, set `PORTUS_MCP_POLICY_PATH=./portus-mcp.policy.local.json`, and retain the full strict policy structure while editing it. (`.gitignore:11`, `src/policy/policyConfig.ts:17-121`)

Provider variables are needed only for spawned-agent work. `PORTUS_MCP_DEFAULT_PROVIDER` selects the provider; the selected provider determines its model and credential variables. Connected-agent catalog and read access, and the seven broad project tools, do not need provider credentials. (`src/config.ts:105-132`, `src/server.ts:16-34`)

## Application Configuration

`portus-mcp.config.json` contains the default subagent template and retry policy plus traversal exclusions. The schema is strict: retry counts and delays must be positive, jitter is between 0 and 1, retry reasons are non-empty strings, and exclusions are non-empty strings. Skill sources are intentionally not accepted in this JSON schema; `AGENT_SKILL_PATHS` and `SUBAGENTS_SKILL_PATHS` are authoritative. (`src/config.ts:40-98`, `src/skills/SkillRegistry.ts:203-280`)

Subagent settings apply to Flue-backed execution via `subagent_task`. Connected-agent skills are cataloged at server startup and read via `project_read`; spawned-subagent skills are cataloged separately and mounted read-only for each subagent session. (`src/server.ts:15-25`, `src/flue/runTask.ts:280-320`, `subagents/ephemeral-project-subagent.ts:75-85`)

## Policy Configuration

`portus-mcp.policy.json` controls subagent lifecycle and concurrency policy, tool permissions, blocked paths, command and Git-ignore constraints, and server-owned limits. (`src/config.ts:11-24`, `src/policy/policyConfig.ts:39-56`)

ChatGPT permissions are:

```text
subagentTask
projectContext
projectRead
projectSearch
projectEdit
projectPatch
projectRun
projectPolicy
```

Each tool maps 1:1 to its permission flag (`subagent_task` requires `subagentTask`, `project_read` requires `projectRead`, etc.). `project_policy` requires `projectPolicy` for all checks and native actions (`register_project`, `update_permissions`, `list_audit`, `read_audit`). Legacy permission flags `registerProjects`, `updatePermissions`, and `spawnSubagents` have been removed. `requireConfirmation` controls whether mutating operations require `confirm: true` (defaults to `true`). `allowShell` controls whether commands may opt into platform shell execution (defaults to `false`). (`src/policy/permissionPolicy.ts:10-45`, `src/tools/config.ts:148-196`, `src/tools/subagents.ts:98-175`)

Portus ships with only `git` in `main_agent.permissions.allowedCommands`. Add direct connected-agent executables under that field; spawned subagents use the separate `subagents.permissions.allowedCommands`. Command entries are executable names containing only letters, digits, `.`, `_`, and `-`; arguments and shell command strings do not belong in the allowlist. On Windows, an invocation ending in `.exe`, `.cmd`, or `.bat` can match its configured basename. (`portus-mcp.policy.json:18-37`, `src/policy/policyConfig.ts:15-53`, `src/policy/permissionPolicy.ts:13-18`)

`allowShell` controls whether Portus permits explicit command opt-in to platform shell execution (`shell: true`); direct commands default to native non-shell execution (`shell: false`). It does not grant an executable and is separate from allowlisting `bash` or another shell directly. Shells and general-purpose interpreters such as Python and Node.js have the authority of the Portus OS account and are not hard-confined to the registered project merely because execution starts there. Grant only commands the operator intends the connected agent to control. (`src/runtime/commands.ts:18-37`, `src/tools/projects.ts:372-387`)

After alias selection, scoped `project_context` exposes the effective direct-agent execution projection: `enabled`, `allowedCommands`, `allowShell`, and `requireConfirmation`. It resolves policy defaults plus global and project-specific runtime overrides, requires `projectContext` rather than administrative `projectPolicy`, and reports permission to attempt a command rather than proof that the executable is installed. (`src/tools/projectBroad.ts:358-406`, `src/state/PermissionRegistry.ts:21-37`)

Project discovery is not a configuration profile or permission bypass. `project_context` with `include.projects=true` and no `projectAlias` returns registered aliases only; after alias selection, default scoped context includes the effective execution projection. Environment pre-registration through `PORTUS_MCP_PROJECTS` and operator-owned configuration/state files remain operator-side facilities, while model-accessible registration, permission updates, and audit reads are confined to native `project_policy` actions and gated by `projectPolicy`. (`src/tools/projectBroad.ts:358-406`, `src/state/ProjectRegistry.ts:35-103`)

Server policy owns file-read, file-write, patch, text-edit, search, per-skill read, agent-output, session-event, audit, timeout, and process bounds. Caller bounds may narrow an authoritative maximum but cannot raise it; callers cannot override blocked paths, Git-ignore handling, permissions, confirmation, or audit. (`src/policy/policyConfig.ts:55-98`, `src/flue/runTask.ts:155-169`)

`limits.search.maxRegexExecutionMs` is the cumulative JavaScript-regex execution budget for one `project_search` section. The default is `120000` ms. Regex matching runs in a worker thread, so pathological backtracking cannot block other MCP work; expiration terminates the worker and returns `regex_search_timeout`. The budget covers regex execution rather than traversal or file I/O and should remain generous enough for legitimate remote model work.

Filesystem authorization uses the canonical registered project root, not lexical path prefixes alone. Registration canonicalizes root paths. Every target or nearest existing creation parent is resolved canonically before access, and mutation, patch, and command boundaries revalidate immediately before side effects. Symlinks and Windows junctions are supported when they resolve inside the same registered root; links that escape the root and broken links that cannot be resolved safely are rejected. Blocked-path policy applies to both the requested path and its canonical destination.

## Security and Audit Semantics

All project access remains confined to registered roots and subject to blocked-path and Git-ignore policy. Destructive or protected operations retain confirmation. Mutation, execution, registration, and permission updates retain durable, redacted audit behavior; reads, context, search, policy checks, audit reads, and patch preparation are unaudited. Safe projections and errors must not disclose absolute roots, bearer tokens, provider credentials, environment details, file contents, or command environments. (`src/config.ts:13-24`, `src/tools/config.ts:117-138`, `src/tools/config.ts:189-217`)

Model-accessible registration, permission mutation, and audit reads are native operations of `project_policy` and remain bounded by `projectPolicy`. Skill-specific MCP tools do not exist: connected agents use catalog metadata plus `project_read`, while spawned subagents receive an audience-specific catalog and read-only skill mounts. (`src/server.ts:15-25`, `src/skills/SkillRegistry.ts:274-307`, `src/flue/runTask.ts:280-320`)

## Defaults and Resolution
1. `PORTUS_MCP_CONFIG_PATH` selects application JSON; otherwise `./portus-mcp.config.json` is used.
2. Specifying a retired `toolSurface` key fails closed.
3. `PORTUS_MCP_POLICY_PATH` selects policy JSON; otherwise `./portus-mcp.policy.json` is used.
4. `PORTUS_MCP_PROJECTS` adds pre-registered project roots; aliases beginning with `skill/` are reserved.
5. Unset `AGENT_SKILL_PATHS` and `SUBAGENTS_SKILL_PATHS` independently default to an existing `./skills` catalog; an explicitly empty value disables that audience.
6. Skill source entries resolve relative to the application configuration directory, and invalid paths or duplicate names fail startup.
7. `PORTUS_MCP_STATE_DIR` selects durable local state; otherwise `.portus-mcp` is used.

Missing or invalid JSON configuration fails startup with file and validation details. Invalid skill source configuration also fails startup rather than silently shrinking access. (`src/config.ts:82-102`, `src/policy/policyConfig.ts:104-124`, `src/skills/SkillRegistry.ts:203-280`, `src/state/ProjectRegistry.ts:80-103`)

## Codebase References

- Fixed nine-tool surface: `src/server.ts:15-25`, `src/config.ts:11-24`
- Direct permission model: `src/config.ts:11-24`, `src/policy/policyConfig.ts:39-56`
- Direct command policy and scoped capability projection: `src/policy/permissionPolicy.ts:13-18`, `src/state/PermissionRegistry.ts:21-37`, `src/tools/projectBroad.ts:358-406`
- HTTP path, bearer token, and port: `src/server.ts:39-51`, `src/server.ts:181-187`
- Project pre-registration and reserved skill alias namespace: `src/state/ProjectRegistry.ts:35-95`
- Policy path: `src/policy/policyConfig.ts:102-122`
- Durable state path: `src/state/StateStore.ts:6-12`
- Audience-specific skill source resolution and discovery: `src/skills/SkillRegistry.ts:203-280`
- Subagent execution and tool registration: `src/tools/subagents.ts:80-210`, `src/flue/runTask.ts:280-320`
- Spawned-subagent skill mounts: `subagents/ephemeral-project-subagent.ts:75-85`
