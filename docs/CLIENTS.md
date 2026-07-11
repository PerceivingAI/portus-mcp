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

## Cold Start and Verification

After the client discovers the seven project tools, use this sequence:

1. Call `project_context` with `include.projects=true` and omit `projectAlias`.
2. Choose one alias from the alias-only response. The response must not contain an absolute root or internal registry metadata.
3. Call `project_context` again with that `projectAlias` and a project-scoped section such as status, tree, files, paths, or scripts.
4. Reuse the alias with the other allowed project tools.

Any project-scoped `project_context` section requires `projectAlias`; only alias discovery can omit it. Registration, permission updates, and audit inspection—when permitted to the model—are native `project_policy` actions. Operator configuration, environment pre-registration, and direct state administration remain operator-only.

The client should show exactly the seven broad tools by default. No management profile, obsolete project/admin tool name, deprecated registration, or compatibility path should appear.
