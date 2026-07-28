# Multi-Machine Use

Portus MCP can work with several machines from the same MCP capable client.

It is recommended to run one Portus MCP server per target machine and adding each one to the client as a separate MCP server.

## Basic Model

```text
Machine A -> Portus MCP A -> MCP client entry A
Machine B -> Portus MCP B -> MCP client entry B
Machine C -> Portus MCP C -> MCP client entry C
```

By doing so, the same ChatGPT, Codex, or other MCP-capable coding harness can access all enabled entries in the same conversation/session.

## Reusing One Entry

You can reuse one installed MCP entry by changing its URL and if bearer auth is enabled, also change the bearer token value for that machine.

This works, but it is slower and easier to mix up.

## Recommended Setup

Create one MCP entry per machine.

Example names:

```text
Portus_LinuxVM
Portus_WinRemote
Portus_Workstation
```

This gives you clearer machine identity, no repeated URL/token changes, and simultaneous access to multiple machines.

It also helps security. Most MCP clients let you enable or disable specific MCP servers, so you can keep several installed and only enable the machines needed for the current session.

## Network Exposure

Expose target machines using Tailscale Funnel for MCP clients like Claude Desktop, Cursor, or Codex (`tailscale funnel 8789`). For ChatGPT connections, configure OpenAI `tunnel-client` profiles (`docs/TUNNEL_CLIENT.md`).

On the target machine, start Portus MCP:

```text
npm start
```

Then expose it:

```text
tailscale funnel 8789
```

On some Linux systems:

```text
sudo tailscale funnel 8789
```

Tailscale prints:

```text
https://machine.tailnet.ts.net/
```

Configure the MCP client with:

```text
https://machine.tailnet.ts.net/mcp
```

The `mcp` part must be added manually.

## What Changes Per Machine

Each Portus MCP server has its own projects, config, policy, provider credentials, optional bearer token, state directory, and OS permissions.

Do not assume two machines expose the same projects or permissions.
