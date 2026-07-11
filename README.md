# Portus MCP

Portus MCP is an MCP server for AI-assisted project work across local machines, remote machines, and VMs. **The connection is the product; tools are policy-bounded adapters.** A client connects to a registered project through one server and uses a small broad surface for ordinary project mobility.

## Default Tool Surface

The default `broad` profile exposes exactly seven tools:

```text
project_context
project_read
project_search
project_edit
project_patch
project_run
project_policy
```

Together they provide bounded project context, ordered reads, search, file and directory edits, patch preparation/application, approved execution, and read-only policy inspection.

Administrative and delegated-agent capabilities are deliberately non-default:

- `management` exposes project registration/listing, permission mutation, and audit inspection only.
- `agent` exposes the existing agent, session, and skill tools only.
- `full` exposes every tool that remains after the hard cutover.

There is no `legacy` profile. Agent/session/skill implementation and behavior are unchanged by the broad refactor; profile selection only controls whether those existing tools are exposed.

## Requirements

You need Node.js 20 or newer, npm, and Git.

For access from another machine or hosted client, use Tailscale Funnel, Cloudflare Tunnel, or another exposure layer that can reach the MCP server.

Provider credentials are needed only when using the non-default agent/session/skill capability. The seven broad project tools do not require provider credentials.

## Install

```text
npm install
```

CI uses Node.js 20 with npm 10. Use npm 10 semantics when updating dependencies or regenerating `package-lock.json` so it stays compatible with `npm ci` in GitHub Actions.

Copy `.env.example` to `.env`. At minimum, register a project:

```text
PORTUS_MCP_PROJECTS=app=C:/path/to/project
```

Separate several projects with semicolons:

```text
PORTUS_MCP_PROJECTS=app=C:/path/to/app;api=C:/path/to/api
```

The shipped `portus-mcp.config.json` selects the default broad surface:

```json
{
  "toolSurface": "broad"
}
```

Keep the remaining required application-config fields from the shipped file. Only add provider credentials when selecting agent functionality.

## Start

```text
npm start
```

Local MCP endpoint:

```text
http://127.0.0.1:8789/mcp
```

Health endpoint:

```text
http://127.0.0.1:8789/
```

## Use From Another Client

Expose the server through Tailscale:

```text
tailscale funnel 8789
```

On systems where Tailscale requires elevation:

```text
sudo tailscale funnel 8789
```

Tailscale prints a root URL such as:

```text
https://machine.tailnet.ts.net/
```

Add the MCP path and configure the client for Streamable HTTP:

```text
https://machine.tailnet.ts.net/mcp
```

## Multi-Machine Use

Run Portus MCP on each machine you want to access. One MCP entry per machine keeps project roots and policies independently selectable:

```text
Portus_LinuxVM
Portus_WinRemote
Portus_Workstation
```

The same conversation can use multiple connections while each server retains its own registered roots, permissions, limits, and availability boundary.

## Security

Broad tools remain bounded by layered enforcement:

- connector, tunnel, MCP server, and process availability;
- registered project-root confinement;
- blocked-path, traversal, and Git-ignore policy;
- capability permissions and approved command policy;
- server-owned request, input, output, scan, patch, edit, timeout, and process limits;
- explicit confirmation for destructive or protected operations;
- durable, redacted audit for mutation and execution;
- operating-system permissions; and
- strict schemas and safe, project-relative errors.

Callers cannot raise server maxima or override path, Git-ignore, permission, confirmation, or audit policy. Read, context, search, policy inspection, and patch preparation remain unaudited; mutation and execution retain audit behavior. Errors and safe policy projections do not expose absolute roots, secrets, command environments, or file contents.

Spawned agents are local command-capable processes, not a hard OS/container/filesystem sandbox. Only enable the `agent` or `full` profile and grant commands you are comfortable allowing.

Fine-tune surface and behavior in `portus-mcp.config.json`, and permissions/limits in `portus-mcp.policy.json`. `PORTUS_MCP_BEARER_TOKEN` is optional for clients that support static bearer authentication; leave it empty for clients that do not.

## Migrating Tool Clients

Retired names have no alias window. Migrate calls by operation family:

| Previous operation | Current adapter |
|---|---|
| Single, whole, ranged, or batch read | `project_read.requests[]` |
| Status, tree, files, path metadata/existence, or scripts | `project_context.include` |
| File, text, or symbol search | `project_search.mode` |
| Patch prepare or apply | `project_patch.mode` |
| Check, script, or command execution | `project_run.type` |
| Write, replace, insert, copy, move, delete, mkdir, or rmdir | `project_edit.operations[]` |
| Permission, path, or safe effective-config inspection | `project_policy.checks[]` |

See `docs/TOOLS.md` for the explicit retired-name map and `docs/BROAD_MOBILITY_SURFACE.md` for the architectural decision.

## Platforms

Windows and Linux were verified for the initial release. macOS is intended to use the same Node.js workflow but was not verified.

## Validation

```text
npm run check
npm test
npm run build
npm run flue:check
npm run smoke:health
npm run smoke:flue-lifecycle
```

`npm run smoke:flue-write` requires real credentials for the selected provider.

The broad-surface acceptance suite must also prove exact seven-tool default discovery, profile isolation, absence of retired names, strict schemas, normal workflows, permission and confirmation boundaries, Git-ignore and root policy, server limits, audit behavior, and safe errors without absolute-path or secret leakage.

## More Documentation

```text
docs/BROAD_MOBILITY_SURFACE.md
docs/CLIENTS.md
docs/CONFIG.md
docs/MULTI_MACHINE.md
docs/TOOLS.md
docs/TROUBLESHOOTING.md
docs/VALIDATION.md
SECURITY.md
```

Start with `docs/BROAD_MOBILITY_SURFACE.md`, `docs/TOOLS.md`, `docs/CLIENTS.md`, and `docs/MULTI_MACHINE.md`.

Flue provides spawned-agent support. Direct broad MCP project tools work without spawned agents.

Flue: https://github.com/withastro/flue
