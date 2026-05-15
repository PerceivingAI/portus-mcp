# Portus MCP

Portus MCP is an MCP server for AI assisted project work.

It lets MCP clients like ChatGPT, Codex, and other AI harnesses work with registered projects through direct project tools. It can also spawn Flue agents when you enable that capability.

You can configure several machines in different locations to run their own Portus MCP servers, with their own configurations and policies, allowing clients to connect to their registered projects separately or within the same conversation.

## Requirements

You need Node.js 20 or newer, npm, and Git.

If you want to connect from another machine or from a hosted client, use Tailscale Funnel, Cloudflare Tunnel, or another exposure layer that can reach your MCP server.

Spawned agents also need credentials for the selected provider. Direct project tools do not need provider credentials unless they spawn agents.

## Install

Run:

```text
npm install
```

Copy `.env.example` to `.env` and set the values you need.

At minimum, set the project list:

```text
PORTUS_MCP_PROJECTS=app=C:/path/to/project
```

For several projects, separate entries with semicolons:

```text
PORTUS_MCP_PROJECTS=app=C:/path/to/app;api=C:/path/to/api
```

Only add credentials for the providers you plan to use.

## Start

Run:

```text
npm start
```

The local MCP endpoint is:

```text
http://127.0.0.1:8789/mcp
```

The health endpoint is:

```text
http://127.0.0.1:8789/
```

## Use It From Another Client

Expose the server through Tailscale:

```text
tailscale funnel 8789
```

On some Linux systems:

```text
sudo tailscale funnel 8789
```

Tailscale prints a root URL like:

```text
https://machine.tailnet.ts.net/
```

Add `mcp` manually:

```text
https://machine.tailnet.ts.net/mcp
```

And use Streamable HTTP in the client.

## Multi-Machine Use

Run Portus MCP on each machine you want to access.

You can reuse one MCP entry by changing the URL, but the better workflow is one MCP entry per machine.

Example names:

```text
Portus_LinuxVM
Portus_WinRemote
Portus_Workstation
```

This lets the same ChatGPT, Codex, or other MCP client work with several machines in one conversation/session. It also lets you disable one machine without uninstalling it.

## Security

Direct project tools stay inside registered project roots and enforce blocked paths, gitignored-file policy, permission gates, output caps, input caps, and audit behavior.

Spawned Flue agents are local command-capable processes. They are useful for delegated work, but they are not a hard OS/container/filesystem sandbox. Only grant commands you are comfortable letting an agent use.

Configuration values and permission policies can be fine tuned in:

`portus-mcp.config.json`

and

`portus-mcp.policy.json`

On clients that support static bearer tokens like Codex you can use the optional `PORTUS_MCP_BEARER_TOKEN`. On clients like ChatGPT custom connector flow, leave it empty.

## Platforms

Windows and Linux were verified for the initial release.

macOS is intended to work through the same Node.js workflow, but it was not verified.

## Validation

Run:

```text
npm run check
npm test
npm run build
npm run flue:check
npm run smoke:health
npm run smoke:flue-lifecycle
npm run validate:public
```

`npm run smoke:flue-write` needs real credentials for the selected provider.

## More Docs

```text
docs/CLIENTS.md
docs/CONFIG.md
docs/MULTI_MACHINE.md
docs/TOOLS.md
docs/TROUBLESHOOTING.md
docs/VALIDATION.md
SECURITY.md
```

I would recommend that you read them, especially `docs/CLIENTS.md` and `docs/MULTI_MACHINE.md`.

Flue is used for spawned-agent support. Direct MCP project tools still work without using spawned agents.

Flue: https://github.com/withastro/flue
