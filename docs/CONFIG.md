# Configuration

Portus MCP uses three main configuration surfaces:

```text
.env
portus-mcp.config.json
portus-mcp.policy.json
```

`.env` is the user facing setup file and the JSON files ship with the app and control structured behavior.

## `.env`

Start by copying `.env.example` to `.env`.

Server settings:

```text
PORTUS_MCP_PORT=8789
PORTUS_MCP_PATH=/mcp
PORTUS_MCP_BEARER_TOKEN=
```

Provider settings are only necessary if you use spawned agents:

```text
PORTUS_MCP_DEFAULT_PROVIDER=cloudflare
PORTUS_MCP_OPENAI_MODEL=gpt-5.4-mini
PORTUS_MCP_CEREBRAS_MODEL=llama3.1-8b
PORTUS_MCP_GEMINI_MODEL=gemini-3.1-flash-lite-preview
PORTUS_MCP_CLOUDFLARE_MODEL=@cf/google/gemma-4-26b-a4b-it
PORTUS_MCP_OPENROUTER_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
OPENAI_API_KEY=
CEREBRAS_API_KEY=
GEMINI_API_KEY=
CLOUDFLARE_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
OPENROUTER_API_KEY=
```

Project list:

```text
PORTUS_MCP_PROJECTS=app=C:/path/to/app;api=C:/path/to/api
```

Use semicolons between projects. The first `=` separates the alias from the path.

File paths:

```text
PORTUS_MCP_CONFIG_PATH=./portus-mcp.config.json
PORTUS_MCP_POLICY_PATH=./portus-mcp.policy.json
PORTUS_MCP_STATE_DIR=.portus-mcp
PORTUS_MCP_FLUE_CLI_PATH=./node_modules/@flue/cli/dist/flue.js
```

## Bearer Token

`PORTUS_MCP_BEARER_TOKEN` is optional.

Use it only with MCP clients that support static bearer auth.

For the tested ChatGPT custom connector flow, leave it empty on ChatGPT since they don't support static bearer tokens.

## `portus-mcp.config.json`

This file controls structured app behavior:

```text
default agent template
retry policy
traversal exclusions
skills directory
```

Skills live in folders like:

```text
skills/security-pass/SKILL.md
skills/security-pass/agents/openai.yaml
```

`skill_list` returns names and descriptions from skill frontmatter.

`skill_read` reads the full selected skill folder.

`skill_run` passes the full selected skill contents to a spawned-agent task.

And you can add your own on the `skills/` folder.

## `portus-mcp.policy.json`

This file controls permission and runtime policy:

```text
max concurrent agents
max concurrent agents per project
queue settings
project lock timeout
grouped limits
audit strict mode
direct tool permissions
spawned-agent permissions
blocked path patterns
allowed ChatGPT and agent commands
```

Default grouped policy shape:

```json
{
  "agents": {
    "concurrency": {},
    "lifecycle": {},
    "permissions": {}
  },
  "chatgpt": {
    "permissions": {}
  },
  "pathPolicy": {
    "blockedPatterns": []
  },
  "limits": {
    "fileRead": {
      "maxChars": 500000
    },
    "fileWrite": {
      "maxChars": 1000000
    },
    "patch": {
      "maxChars": 1000000
    },
    "textEdit": {
      "maxOperationChars": 200000,
      "maxSearchOrMarkerChars": 20000
    },
    "search": {
      "maxScanEntries": 100000,
      "maxTextFileChars": 200000
    },
    "skills": {
      "maxReadChars": 200000
    },
    "agentOutput": {
      "maxStdoutChars": 200000,
      "maxStderrChars": 200000
    },
    "sessionEvents": {
      "maxEvents": 500,
      "maxChunkChars": 4000
    },
    "audit": {
      "maxEvents": 1000
    },
    "process": {
      "maxOutputBufferMb": 10
    }
  }
}
```

`limits.fileRead.maxChars` is the hard cap for project file read output.

`limits.sessionEvents.maxEvents` and `limits.audit.maxEvents` are hard caps for session events and audit event lists.

`limits.search.maxTextFileChars` replaces tool-level char arguments. Callers do not choose char output limits per request.

Text-facing limits under `limits.fileRead`, `limits.fileWrite`, `limits.patch`, and `limits.textEdit` count Unicode code points. `limits.process.maxOutputBufferMb` is the only size-based limit because it protects process buffer memory rather than user text.

Agent timing defaults:

```json
{
  "agents": {
    "lifecycle": {
      "startupWatchdogMs": 15000,
      "forcedCloseGraceMs": 8000,
      "killEscalationDelayMs": 1200,
      "queueDrainDelayMs": 50
    }
  }
}
```

Direct tool permissions under `chatgpt.permissions`:

```text
registerProjects
updatePermissions
spawnAgents
readFiles
writeFiles
moveFiles
deleteFiles
readGitIgnoredFiles
runPackageScripts
allowedCommands
```

Spawned-agent settings under `agents.permissions` and `agents.lifecycle`:

```text
networkAccess
allowedCommands
maxRuntimeSecs
```

Set either agent limit to `0` to disable spawned-agent runs:

```json
{
  "agents": {
    "concurrency": {
      "maxConcurrent": 0
    }
  }
}
```

or:

```json
{
  "agents": {
    "concurrency": {
      "maxConcurrentPerProject": 0
    }
  }
}
```

## Default Permissions

The shipped policy enables file writes, moves, deletes, package scripts, and `git` command access for registered projects.

Deletes still require confirmation.

If you want read/write-only project access, set:

```json
{
  "chatgpt": {
    "permissions": {
      "runPackageScripts": false,
      "moveFiles": false,
      "deleteFiles": false,
      "allowedCommands": []
    }
  }
}
```

## Providers

Only the selected provider needs credentials.

Currently, the supported providers:

```text
openai
cerebras
gemini
cloudflare
openrouter
```
