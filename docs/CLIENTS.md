# MCP Clients

Portus MCP is a Streamable HTTP MCP server and you can make it accessible by using this endpoint shape:

```text
https://machine.tailnet.ts.net/mcp
```

For Tailscale setup (Tailscale Serve for private devices, Tailscale Funnel for public cloud connectors), see `docs/TAILSCALE.md`. Tailscale prints a root URL:

```text
https://machine.tailnet.ts.net/
```

Add `/mcp` (or your configured `PORTUS_MCP_PATH`) manually in the MCP client.

## ChatGPT

ChatGPT connects to Portus MCP via OpenAI Secure MCP Tunnel using `tunnel-client` (`docs/TUNNEL_CLIENT.md`).
1. Launch Portus MCP and `tunnel-client` together with `npm run start:tunnel` (or start Portus MCP with `npm start` and `tunnel-client` in a second terminal).
2. In ChatGPT web: account button -> Settings -> Plugins -> Browse plugins -> click + to add plugin -> select Tunnel -> pick your tunnel -> select No Auth -> tick disclaimer -> Connect.
3. `PORTUS_MCP_BEARER_TOKEN` must be left empty in `.env` for the No Auth tunnel configuration.
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

After the client discovers the ten MCP tools, use this sequence:

1. Call `project_context` with `include.projects=true` and omit `projectAlias`.
2. Choose one alias from the alias-only response. The response must not contain an absolute root or internal registry metadata.
3. Call scoped `project_context` with that `projectAlias`. The default response reports the selected operator policy's complete positive `capabilities` allowlist plus status, tree, and scripts.
4. Treat `capabilities.availableTools` as the effective planning authority. Invoke only listed exact tool names; for `project_run`, use only its nested `allowedCommands`. Registered tools absent from the allowlist remain visible through MCP discovery but must not be invoked.

Any project-scoped `project_context` section requires `projectAlias`; only alias discovery can omit it. The alias selects project context, not a different permission policy. Audit inspection—when permitted to the model—is a native `project_policy` action. Project registration is configured exclusively through the environment (`PORTUS_MCP_PROJECTS`). Policy inspection is read-only, and no MCP action can change permissions. Operator policy editing, environment registration, and direct state administration remain operator-only.

Every returned capability entry is enabled. Disabled tools and features are omitted rather than returned as `enabled: false`; `complete: true` makes absence unambiguous. This report improves planning but is not a security boundary—runtime permission and request-specific checks remain authoritative.

The client should show exactly ten tools, including `project_screenshot`. No management profile, obsolete project/admin tool name, deprecated registration, or compatibility path should appear. Clients that support native MCP image blocks can display `project_screenshot` capture and read results directly; base64 is not duplicated into structured metadata.
