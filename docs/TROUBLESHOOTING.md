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

## Tailscale URL Does Not Work

Tailscale prints:

```text
https://machine.tailnet.ts.net/
```

Use this in the MCP client:

```text
https://machine.tailnet.ts.net/mcp
```

On Linux, the command may need sudo:

```text
sudo tailscale funnel 8789
```

## ChatGPT Cannot Connect

Check that the URL ends in `/mcp`, the server is running, and Tailscale Funnel is active.

For the tested ChatGPT custom connector flow, leave `PORTUS_MCP_BEARER_TOKEN` empty.

## Codex Desktop Shows Enabled But Tools Are Missing

Restart Codex Desktop.

In testing, the MCP entry showed as enabled before this session could see or use the tools.

## Permission Denied

Inspect the current state with:

```text
permission_get
effective_config_show
agent_limits
```

Common causes:

```text
chatgpt.permissions.spawnAgents=false
chatgpt.permissions.runPackageScripts=false
chatgpt.permissions.moveFiles=false
chatgpt.permissions.deleteFiles=false
agents.concurrency.maxConcurrent=0
agents.concurrency.maxConcurrentPerProject=0
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
