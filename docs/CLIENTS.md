# MCP Clients

Portus MCP is a Streamable HTTP MCP server and you can make it accessible by using this endpoint shape:

```text
https://machine.tailnet.ts.net/mcp
```

For example, I use Tailscale Funnel which prints only the root URL:

```text
https://machine.tailnet.ts.net/
```

Where you have to add `/mcp` manually in the MCP client.

## ChatGPT

On ChatGPT, you have to first open the Settings modal, then go to Apps, Advanced Settings, Developer Mode, and Create app.

Here you will be presented by the configuration modal where you will be able to add the name and URL of the Portus MCP.

Unlike Codex, ChatGPT does not accept the `PORTUS_MCP_BEARER_TOKEN` so it should be left empty on the `.env` file if you plan to use the MCP there. Select No Auth, tick the checkbox, and Create.

## Codex Desktop

For the Codex Desktop App (Windows and Mac), go to Settings, MCP Servers, Add Server, and select `Streamable HTTP MCP server`. Add the name and URL of the Portus MCP.

Here you can add the `PORTUS_MCP_BEARER_TOKEN` if you have it configured on the `.env` file.

Use:

```text
https://machine.tailnet.ts.net/mcp
```


Notes:

1. adding the MCP in Codex Desktop also made it appear in the Codex CLI.
2. Codex Desktop showed the server as enabled, but this session could only see the server after restarting the desktop app.

## Codex CLI

You can also at the MCP server directly through `~/.codex/config.toml`.

Without the bearer auth:

```toml
[mcp_servers.portus_mcp]
url = "https://machine.tailnet.ts.net/mcp"
```

With the bearer auth:

```toml
[mcp_servers.portus_mcp]
url = "https://machine.tailnet.ts.net/mcp"
bearer_token_env_var = "PORTUS_MCP_BEARER_TOKEN"
```

Or use the CLI command:

```text
codex mcp add portus_mcp --url https://machine.tailnet.ts.net/mcp
```

You can verify it is ready by using the command `/mcp`.

Reference:

```text
https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-codex.md
```

## Other MCP Clients

Use Streamable HTTP and iff the client supports static bearer auth, you can use `PORTUS_MCP_BEARER_TOKEN`.

If it does not, leave `PORTUS_MCP_BEARER_TOKEN` empty or use another exposure layer that handles access control.

## Verification

You should ask the client to list registered projects and expect to see:

1. The Portus MCP server appears in the MCP client (with your chosen name).
2. Project tools are listed.
3. Registered projects are visible.
4. Direct project tools operate only inside registered project roots.
