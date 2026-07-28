# Troubleshooting

Use this file when Portus MCP starts, connects, or behaves differently than expected.

## Server Does Not Start

Check Node.js first:

```text
node -v
```

Portus MCP requires Node.js 20 or newer.

Then confirm dependencies are installed:

```text
npm install
```

CI runs on Node.js 20 with npm 10. If GitHub Actions fails at `npm ci` with a missing package from `package-lock.json`, regenerate the lockfile with npm 10 semantics before committing it. A newer local npm version can produce a lockfile that installs locally but still fails in CI.

If config paths were changed, confirm these files exist:

```text
portus-mcp.config.json
portus-mcp.policy.json
```

## Missing Provider Credentials

Spawned-agent use requires credentials for the selected provider.

Direct MCP project tools do not need provider credentials unless they spawn agents.

If an agent spawn fails with a missing key message, set the credential values for the selected provider in `.env`.

## Network Exposure & Client Connection

### Tailscale Funnel

Tailscale Funnel exposes the local server to MCP clients such as Claude Desktop, Cursor, or custom HTTP MCP clients. Tailscale prints a base URL:

```text
https://machine.tailnet.ts.net/
```

Append `/mcp` in your client configuration:

```text
https://machine.tailnet.ts.net/mcp
```

On Linux, elevated permissions may be required (`sudo tailscale funnel 8789`).

### ChatGPT Connection via `tunnel-client`

ChatGPT connects via OpenAI `tunnel-client` (`docs/TUNNEL_CLIENT.md`).

1. Confirm Portus MCP is running locally (`npm start`) on `http://127.0.0.1:8789/mcp`.
2. Confirm `tunnel-client` is running in a second terminal using your OpenAI Platform tunnel profile.
3. In ChatGPT web plugin settings, select the tunnel, choose **No Auth**, tick the disclaimer, and click **Connect**.
4. Leave `PORTUS_MCP_BEARER_TOKEN` empty when using the standard No Auth tunnel configuration.
## Codex Desktop Shows Enabled But Tools Are Missing

Restart Codex Desktop.

In testing, the MCP entry showed as enabled before this session could see or use the tools.

## Permission Denied

Inspect policy state and diagnostic checks with `project_policy`:

```json
{
  "checks": [
    { "type": "path", "projectAlias": "app", "relativePath": "src/index.ts" }
  ]
}
```

Or check subagent capabilities via `subagent_context`:

```json
{
  "requests": [{ "type": "capabilities" }]
}
```

Common causes:

```text
chatgpt.permissions.subagentTask=false
chatgpt.permissions.projectRun=false
chatgpt.permissions.projectEdit=false
subagents.concurrency.maxConcurrent=0
subagents.concurrency.maxConcurrentPerProject=0
```
## Path Blocked

The path may escape the registered project root, match a blocked path pattern, or be gitignored while `readGitIgnoredFiles=false`.

## Flue CLI Missing

Run:

```text
npm install
```

The default Flue CLI path is:

```text
./node_modules/@flue/cli/dist/flue.js
```
