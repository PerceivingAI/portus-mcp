# Detailed Security Model

This document explains the security behavior.

This initial public repository does not include public PR intake, contributor intake, or public vulnerability-report intake instructions.

## Endpoint Exposure

The local MCP endpoint is usually:

```text
http://127.0.0.1:8789/mcp
```

When using Tailscale Funnel, the MCP endpoint is:

```text
https://machine.tailnet.ts.net/mcp
```

Tailscale prints only the root URL, so add `/mcp` manually.

## Direct Project Tools

Direct file-oriented project tools are the safest way for an MCP client to inspect and edit project files.

Portus MCP controls each operation and applies registered project roots, relative path resolution, blocked path patterns, gitignored-file policy, permission gates, input caps, output caps, and audit writes.

## Path Policy

Project paths are resolved from the registered project root.

Portus MCP blocks path escapes, absolute paths where relative paths are required, `pathPolicy.blockedPatterns`, and gitignored paths when ignored-file reads are disabled.

## Gitignored Files

When `main_agent.permissions.readGitIgnoredFiles=false`, ignored files are opaque.

Portus MCP blocks reads, metadata checks, copy sources, overwrites, deletes, directory deletes, replace/insert/patch edits, and ignored `package.json` script discovery or execution.

## Permission Gates

Main agent permissions are:

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

Every MCP tool checks its corresponding permission at entry: `subagent_task` requires `subagentTask`, `subagent_context` requires `subagentContext`, `project_read` requires `projectRead`, `project_screenshot` requires `projectScreenshot`, and so on. Screenshot authority is independent from project execution, reading, and editing. `project_policy` requires `projectPolicy` for checks and native actions (`list_audit`, `read_audit`). `readGitIgnoredFiles` remains an internal constraint. Scoped `project_context.capabilities` is planning information; runtime permission, path, ownership, confirmation, and validation gates remain authoritative.

Spawned-agent permissions include:

```text
networkAccess
allowedCommands
maxRuntimeSecs
```

Direct tool permissions and spawned-agent permissions are separate and can be found on `portus-mcp.policy.json`.

Portus ships with only `git` in `main_agent.permissions.allowedCommands`. Operators explicitly grant other device-installed executables; direct tool permissions and spawned-agent permissions remain separate. Git, shells, interpreters, and other granted commands can expose or change state beyond the narrower file-tool path policy. A project-root working directory is not a hard filesystem sandbox: allowlisting Bash, PowerShell, Python, Node.js, or another general-purpose interpreter grants the authority available to that executable under the Portus OS account. Add only commands the connected agent is intended to control.

## Session-Owned Screenshot Boundary

`project_screenshot` does not grant desktop, monitor, active-window, arbitrary-window, or screen-region capture. `discover_running` and `capture_running` require a running `project_run` execution session and accept only visible windows whose owner PID belongs to the freshly attested session process set; `capture_launch` spawns an authorized command directly with session lifecycle management. Native window handles and PIDs never leave the worker/runtime boundary.

Every screenshot operation requires the same `projectAlias` and `executionSessionId` (or `command` for `capture_launch`). Captures are stored only under `.portus-artifacts/screenshots/<executionSessionId>/` in that registered project. Portus generates filenames, validates canonical containment, creates temporary files exclusively, validates encoded bytes before publication and read, and returns base64 only in native MCP image blocks. Screenshots persist until an explicit `delete`; Portus performs no automatic count-, byte-, or age-based deletion.

Window selection tokens are random, project/session scoped, short lived, and invalidated when the execution session exits or Portus restarts. Windows, macOS, and Linux X11 use the isolated child worker. Wayland fails closed when ownership cannot be attested. (`src/runtime/screenshotSystem.ts:78-1157`, `scripts/screenshot-worker.mjs:36-439`, `src/tools/projectScreenshot.ts:34-216`)

## Spawned Agents

Spawned agents use Flue and run as local processes with cwd set to the registered project root.

They are useful for delegated work, but they are not a hard filesystem sandbox. If a spawned agent receives command access, it may be able to read files allowed by OS permissions and granted commands.

Disable subagent lifecycle actions with `main_agent.permissions.subagentTask=false`, `subagents.concurrency.maxConcurrent=0`, or `subagents.concurrency.maxConcurrentPerProject=0`. Independently disable session listings, status, stdout/stderr, results, events, and capability inspection with `main_agent.permissions.subagentContext=false`.

## Provider Credentials

The Portus MCP process reads provider credentials from environment variables.

Spawned Flue child processes receive only the active provider credentials needed for the selected provider.

Inactive provider credentials are not passed to the child process.

## Bearer Auth

Bearer auth is optional and depends on client support. When `PORTUS_MCP_BEARER_TOKEN` is set, MCP requests must send a matching bearer token.

Do not enable this for clients that cannot send static bearer tokens.

## Audit

State-changing tools write audit events. When audit strict mode is enabled, selected mutations fail if audit writing fails.

## Practical Hardening

Register only the project roots you want exposed.

Keep `.env` and private paths blocked.

Keep `readGitIgnoredFiles=false` unless the current session needs ignored-file access.

Disable `projectEdit`, `projectRun`, `allowedCommands`, or spawned agents when a session should not use them.

Use separate MCP entries per machine and disable entries that should not be active in the current session.
