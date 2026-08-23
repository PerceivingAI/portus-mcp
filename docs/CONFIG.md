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

`.env` selects process, project, provider, skill-source, and file locations. `portus-mcp.config.json` controls the tool surface and structured application behavior. Exactly one complete policy file owns permissions and runtime limits: the path selected by `PORTUS_MCP_POLICY_PATH`, or the shipped `./portus-mcp.policy.json` when the variable is unset. Unknown application-config or policy keys and invalid values fail validation rather than being ignored. (`src/config.ts:71-102`, `src/skills/SkillRegistry.ts:203-212`, `src/policy/policyConfig.ts:103-127`)

## Tool Surface

Portus MCP exposes one fixed ten-tool surface:

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
  "traversal": { "excludedPatterns": [".git", "node_modules", "dist", ".portus-mcp", ".portus-artifacts"] }
}
```

## Environment Variables

Server, authentication, and combined-launcher variables:

```text
PORTUS_MCP_HOST=127.0.0.1
PORTUS_MCP_PORT=8789
PORTUS_MCP_PATH=/mcp
PORTUS_MCP_BEARER_TOKEN=
PORTUS_TUNNEL_CLIENT_PATH=
PORTUS_TUNNEL_PROFILE=portus-local
PORTUS_MCP_FORWARD_EXTERNAL_LOGS=false
```

The host defaults to `127.0.0.1`, the port defaults to `8789`, the MCP route defaults to `/mcp`, and an empty bearer token disables static bearer authentication. `PORTUS_TUNNEL_CLIENT_PATH` and `PORTUS_TUNNEL_PROFILE` tune single-command launcher orchestration (`npm run start:tunnel`). `PORTUS_MCP_FORWARD_EXTERNAL_LOGS` controls whether the combined tunnel, funnel, and serve launchers copy external-service stdout and stderr to the terminal. It defaults to `false`; `1`, `true`, `yes`, and `on` enable forwarding without hiding the Portus or orchestrator lifecycle messages. (`scripts/start-all.mjs:8-18`, `scripts/start-all.mjs:104-115`, `scripts/start-all.mjs:253-270`)

Pre-register projects with `alias=absolute/path` entries, written on separate lines inside single quotes (or separated by newlines, pipes, or semicolons):

On Windows:
```env
PORTUS_MCP_PROJECTS='
  app=C:\path\to\app
  api=C:\path\to\api
'
```

On Linux:
```env
PORTUS_MCP_PROJECTS='
  app=/home/user/projects/app
  api=/home/user/projects/api
'
```

Malformed entries and reserved `skill/` aliases fail with actionable errors. (`src/state/ProjectRegistry.ts:35-40`, `src/state/ProjectRegistry.ts:80-107`)

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

Those values resolve the application config, selected complete policy, and durable state directory respectively. `PORTUS_MCP_POLICY_PATH` is a selector, not an overlay source: the selected file is never merged with the shipped policy. When it is unset or empty, Portus loads `./portus-mcp.policy.json`. A configured missing file, malformed JSON, unknown key, or invalid value fails startup with file and schema details. (`src/config.ts:82-102`, `src/policy/policyConfig.ts:103-127`, `src/state/StateStore.ts:6-24`)

For a private operator policy, copy the complete shipped `portus-mcp.policy.json` to the Git-ignored `portus-mcp.policy.local.json`, retain its full strict structure while editing it, and set `PORTUS_MCP_POLICY_PATH=./portus-mcp.policy.local.json`. Files under `PORTUS_MCP_STATE_DIR` hold operational state only; they cannot widen or narrow selected-policy permissions. (`.gitignore:11`, `src/policy/policyConfig.ts:103-137`, `src/state/StateStore.ts:6-31`)

Provider variables are needed only for spawned-agent work. `PORTUS_MCP_DEFAULT_PROVIDER` selects the provider; the selected provider determines its model and credential variables. Connected-agent catalog and read access, and the seven broad project tools, do not need provider credentials. (`src/config.ts:105-132`, `src/server.ts:16-34`)

## Application Configuration

`portus-mcp.config.json` contains the default subagent template and retry policy plus traversal exclusions. The schema is strict: retry counts and delays must be positive, jitter is between 0 and 1, retry reasons are non-empty strings, and exclusions are non-empty strings. Skill sources are intentionally not accepted in this JSON schema; `AGENT_SKILL_PATHS` and `SUBAGENTS_SKILL_PATHS` are authoritative. (`src/config.ts:40-98`, `src/skills/SkillRegistry.ts:203-280`)

Subagent settings apply to Flue-backed execution via `subagent_task`. Connected-agent skills are cataloged at server startup and read via `project_read`; spawned-subagent skills are cataloged separately and mounted read-only for each subagent session. (`src/server.ts:15-25`, `src/flue/runTask.ts:280-320`, `subagents/ephemeral-project-subagent.ts:75-85`)

## Policy Configuration

`portus-mcp.policy.json` controls subagent lifecycle and concurrency policy, tool permissions, blocked paths, command and Git-ignore constraints, and server-owned limits. (`src/config.ts:11-25`, `src/policy/policyConfig.ts:39-53`)

ChatGPT permissions are:

```text
subagentTask
subagentContext
projectContext
projectRead
projectSearch
projectEdit
projectPatch
projectRun
projectPolicy
projectScreenshot
```

Each tool maps 1:1 to its permission flag: `subagent_task` requires `subagentTask`, `subagent_context` requires `subagentContext`, `project_read` requires `projectRead`, `project_screenshot` requires `projectScreenshot`, and so on. The two subagent permissions are independent, allowing lifecycle control and read-only session inspection to be granted separately. `projectScreenshot` independently gates `targets`, `capture`, `read`, `list`, and `delete`; it is never inferred from `projectRun`, `projectRead`, or `projectEdit`. `project_policy` requires `projectPolicy` for checks and its native actions (`register_project`, `list_audit`, and `read_audit`). (`src/policy/policyConfig.ts:46-129`, `src/tools/projectScreenshot.ts:104-216`)

Portus ships with only `git` in `main_agent.permissions.allowedCommands`. Add direct connected-agent executables under that field; spawned subagents use the separate `subagents.permissions.allowedCommands`. Command entries are executable names containing only letters, digits, `.`, `_`, and `-`; arguments and shell command strings do not belong in the allowlist. On Windows, an invocation ending in `.exe`, `.cmd`, or `.bat` can match its configured basename. (`portus-mcp.policy.json:18-37`, `src/policy/policyConfig.ts:15-53`, `src/policy/permissionPolicy.ts:13-18`)

`allowShell` controls whether Portus permits explicit command opt-in to platform shell execution (`shell: true`); direct commands default to native non-shell execution (`shell: false`). It does not grant an executable and is separate from allowlisting `bash` or another shell directly. Shells and general-purpose interpreters such as Python and Node.js have the authority of the Portus OS account and are not hard-confined to the registered project merely because execution starts there. Grant only commands the operator intends the connected agent to control. (`src/runtime/commands.ts:18-37`, `src/tools/projects.ts:372-387`)

After alias selection, scoped `project_context` projects the selected complete policy into `capabilities`: `complete: true`, exact authorized tool names under `availableTools`, and only enabled dependent `features`. Disabled entries are omitted, not reported as `enabled: false`. `subagent_task` and `subagent_context` appear independently according to `subagentTask` and `subagentContext`; `project_run.allowedCommands` appears only when `projectRun` is enabled; `shell` additionally requires `allowShell`; ignored-file and protected-operation features appear only when their permissions and applicable operations make them usable. The project alias supplies project context but never changes permissions. This report grants permission to attempt an operation, not proof that an executable is installed or that request-specific checks will pass. (`src/tools/projectBroad.ts:60-87`, `src/tools/subagents.ts:206-216`)

Project discovery is not a configuration profile or permission bypass. `project_context` with `include.projects=true` and no `projectAlias` returns registered aliases only; after alias selection, default scoped context includes the positive capability allowlist. The projector consumes the same resolved `PortusPolicyConfig` supplied to the MCP server and does not load a second filename or assume the shipped default: `PORTUS_MCP_POLICY_PATH` remains the authoritative complete-policy selector, while `PORTUS_MCP_CONFIG_PATH` independently selects application configuration. Environment pre-registration through `PORTUS_MCP_PROJECTS` remains operator-side, and model-accessible registration and audit reads remain gated `project_policy` actions. (`src/policy/policyConfig.ts:122-142`, `src/server.ts:20-32`, `src/server.ts:50-55`, `src/server.ts:180-184`)

Server policy owns file-read, file-write, patch, text-edit, search, per-skill read, agent-output, session-event, audit, timeout, and process bounds. Caller bounds may narrow an authoritative maximum but cannot raise it. Search excludes Git-ignored paths by default; `includeGitIgnored: true` explicitly widens only that request and is accepted only when the selected policy grants `readGitIgnoredFiles`. Explicit traversal exclusions still win. (`src/tools/projectBroad.ts:506-559`, `src/tools/projects.ts:277-287`, `src/policy/policyConfig.ts:130-137`)

`limits.screenshot` owns per-image and request bounds only:

```json
{
  "maxBytes": 8388608,
  "maxWidth": 3840,
  "maxHeight": 2160,
  "captureTimeoutMs": 10000,
  "maxWindowWaitMs": 30000,
  "windowTokenTtlMs": 30000,
  "maxListPageSize": 100,
  "minJpegQuality": 50,
  "maxJpegQuality": 95
}
```

`maxBytes`, `maxWidth`, and `maxHeight` bound one encoded screenshot. `captureTimeoutMs` bounds one worker request; `maxWindowWaitMs` bounds caller-requested window waiting; `windowTokenTtlMs` bounds opaque target-token lifetime; `maxListPageSize` bounds metadata returned in one page; JPEG quality must stay between the configured minimum and maximum. These fields do not limit the number or age of stored screenshots. Captures persist until explicit `delete`. (`src/policy/policyConfig.ts:16-34`, `src/runtime/screenshotSystem.ts:55-105`, `src/runtime/screenshotSystem.ts:1133-1173`)

`limits.textEdit.maxRangeLines` is a required positive integer that caps the inclusive width of each `replace_range` operation; the shipped policy sets it to `2000`. Range edits that exceed the selected policy limit are rejected before mutation. (`src/policy/policyConfig.ts:67-71`, `src/tools/projectEdit.ts:281-293`, `portus-mcp.policy.json:61-65`)

`limits.textEdit.maxOperationChars` bounds each replacement or insertion payload, while `limits.textEdit.maxSearchOrMarkerChars` bounds each exact search or marker. `limits.fileWrite.maxChars` also bounds the complete projected file after every `replace`, `insert`, or `replace_range`, including projected same-path staged state; an individually valid payload cannot grow the resulting file past that limit. These text limits count Unicode code points rather than UTF-16 code units. (`src/tools/projectEdit.ts:794-820`, `src/tools/projectEdit.ts:834-859`, `src/tools/projectEdit.ts:877-905`)

`limits.search.maxRegexExecutionMs` is the cumulative JavaScript-regex execution budget for one `project_search` section. The default is `120000` ms. Regex matching runs in a worker thread, so pathological backtracking cannot block other MCP work; expiration terminates the worker and returns `regex_search_timeout`. The budget covers regex execution rather than traversal or file I/O and should remain generous enough for legitimate remote model work.

Filesystem authorization uses the canonical registered project root, not lexical path prefixes alone. Registration canonicalizes root paths. Every target or nearest existing creation parent is resolved canonically before access, and mutation, patch, and command boundaries revalidate immediately before side effects. Symlinks and Windows junctions are supported when they resolve inside the same registered root; links that escape the root and broken links that cannot be resolved safely are rejected. Blocked-path policy applies to both the requested path and its canonical destination.

## Security and Audit Semantics

All project access remains confined to registered roots and subject to blocked-path and Git-ignore policy. Destructive or protected operations retain confirmation. Mutation, execution, and registration retain durable, redacted audit behavior; reads, context, search, policy checks, audit reads, and patch preparation are unaudited. Safe projections and errors must not disclose absolute roots, policy-file paths, bearer tokens, provider credentials, environment details, file contents, or command environments. (`src/config.ts:13-24`, `src/tools/config.ts:95-120`, `src/tools/config.ts:170-192`)

MCP callers can inspect safe effective-policy projections but cannot mutate permissions. Runtime state remains limited to operational records such as projects, sessions, audit, and workspaces and is not a permission authority. Skill-specific MCP tools do not exist: connected agents use catalog metadata plus `project_read`, while spawned subagents receive an audience-specific catalog and read-only skill mounts. (`src/tools/config.ts:123-192`, `src/state/StateStore.ts:6-31`, `src/skills/SkillRegistry.ts:274-307`)

## Defaults and Resolution
1. `PORTUS_MCP_CONFIG_PATH` selects application JSON; otherwise `./portus-mcp.config.json` is used.
2. Specifying a retired `toolSurface` key fails closed.
3. `PORTUS_MCP_POLICY_PATH` selects one complete strict policy; when unset, `./portus-mcp.policy.json` is used. No merge or runtime override layer exists.
4. `PORTUS_MCP_PROJECTS` adds pre-registered project roots; aliases beginning with `skill/` are reserved.
5. Unset `AGENT_SKILL_PATHS` and `SUBAGENTS_SKILL_PATHS` independently default to an existing `./skills` catalog; an explicitly empty value disables that audience.
6. Skill source entries resolve relative to the application configuration directory, and invalid paths or duplicate names fail startup.
7. `PORTUS_MCP_STATE_DIR` selects durable local state; otherwise `.portus-mcp` is used.

Missing or invalid JSON configuration fails startup with file and validation details. A configured policy path is never allowed to fall back to or merge with the shipped policy. Invalid skill source configuration also fails startup rather than silently shrinking access. (`src/config.ts:82-102`, `src/policy/policyConfig.ts:103-127`, `src/skills/SkillRegistry.ts:203-280`, `src/state/ProjectRegistry.ts:80-103`)

## Codebase References

- Fixed ten-tool surface: `src/server.ts:21-37`, `src/tools/projectScreenshot.ts:122-216`
- Selected-policy permission model: `src/policy/policyConfig.ts:103-137`, `src/policy/permissionPolicy.ts:6-30`
- Direct command policy and safe capability projection: `src/policy/permissionPolicy.ts:13-23`, `src/tools/projectBroad.ts:490-503`
- Read-only effective-policy inspection and native actions: `src/tools/config.ts:51-67`, `src/tools/config.ts:123-192`
- HTTP path, bearer token, and port: `src/server.ts:39-51`, `src/server.ts:181-187`
- Project pre-registration and reserved skill alias namespace: `src/state/ProjectRegistry.ts:35-95`
- Policy selection and fail-closed validation: `src/policy/policyConfig.ts:103-127`
- Non-authoritative durable state path: `src/state/StateStore.ts:6-31`
- Audience-specific skill source resolution and discovery: `src/skills/SkillRegistry.ts:203-280`
- Subagent execution and tool registration: `src/tools/subagents.ts:80-210`, `src/flue/runTask.ts:280-320`
- Spawned-subagent skill mounts: `subagents/ephemeral-project-subagent.ts:75-85`
