# Flue Integration

Portus MCP uses Flue for spawned agent support.

Direct MCP project tools still work without using spawned agents.

Flue:

```text
https://github.com/withastro/flue
```

License:

```text
Apache-2.0
```

## What Uses Flue

Spawned subagent operations use `subagent_task` (`action: "start"`, `"stop"`, `"cleanup"`) and `subagent_context`:

```text
subagent_task
subagent_context
```

Skills do not add alternate run tools. Every spawned task receives the metadata catalog selected by `SUBAGENTS_SKILL_PATHS`; the spawned agent chooses applicable skills and reads them from its read-only filesystem view. Portus MCP handles the MCP layer, policy checks, session tracking, logs, events, artifacts, cleanup, and audience-specific skill selection. Flue handles the spawned agent runtime.

## CLI Path

The default Flue CLI path is:

```text
./node_modules/@flue/cli/dist/flue.js
```

Override it with:

```text
PORTUS_MCP_FLUE_CLI_PATH=/path/to/flue.js
```

## Provider Mapping

Portus provider names map to Flue/pi-ai provider ids.

Examples:

```text
cloudflare -> cloudflare-workers-ai
gemini     -> google
openrouter -> openrouter
```

## Child Environment

Spawned Flue processes receive a sanitized environment.

They receive only the credentials needed for the selected provider. They do not receive the full parent process environment.

## Commands

Agent command access is controlled by:

```text
subagents.permissions.allowedCommands in portus-mcp.policy.json
subagent capability gates in portus-mcp.policy.json
```

Grant only commands you want spawned agents to use.

## Workspace and Skills

Spawned agents see the registered project as a writable `/workspace` root. Flue workspaces are staged internally inside `.portus-mcp/flue-workspaces/<sessionId>` to keep user project roots 100% clean of `.flue/` or `agents/` directories. Configured subagent skill packages are mounted separately at `/skills/<name>` as read-only roots with per-file read limits.

The subagent template is located at `subagents/ephemeral-project-subagent.ts`. The subagent receives name, description, supported host metadata, and stable in-sandbox locations at initialization. It reads a selected `SKILL.md`, references, assets, or scripts itself through its normal filesystem and command capabilities. Absolute host skill paths are not put in model context, and a skill mount grants no access to its catalog parent or adjacent skills.

## Session Artifacts & Inspection

Subagent status, stdout/stderr logs, execution events, and result artifacts are read using `subagent_context`. Session stop and artifact cleanup are performed using `subagent_task`.

Retry policy lives in:

```text
portus-mcp.config.json
```

The current retry classes cover provider rate limits, transient network failures, and Flue startup hangs.
