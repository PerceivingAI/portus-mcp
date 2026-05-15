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

These tools start spawned-agent work:

```text
agent_spawn
agent_run_task
agent_run_skill
skill_run
```

Portus MCP handles the MCP tool layer, policy checks, session tracking, logs, events, artifacts, and cleanup. Flue handles the spawned agent runtime.

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
agents.allowedCommands in portus-mcp.config.json
agent permissions in portus-mcp.policy.json
```

Grant only commands you want spawned agents to use.

## Workspace

Spawned agents run with cwd set to the registered project root.

This is not a hard filesystem sandbox. A command capable local process can access files allowed by OS permissions and granted commands.

## Sessions

Session tools expose status, events, logs, artifacts, stop controls, and cleanup controls.

Use `session_read_events` for progress. It avoids rereading full logs each time.

## Retry

Retry policy lives in:

```text
portus-mcp.config.json
```

The current retry classes cover provider rate limits, transient network failures, and Flue startup hangs.
