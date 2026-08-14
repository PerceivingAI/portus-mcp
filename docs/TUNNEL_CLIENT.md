# OpenAI Secure MCP Tunnel Client Setup

This guide explains how to set up OpenAI `tunnel-client` for use with Portus MCP.

It covers:

```text
- downloading tunnel-client
- creating a tunnel in OpenAI Platform
- setting the tunnel-client API key
- creating a local tunnel-client profile
- validating the profile
- running tunnel-client
```

This guide is only about the OpenAI Secure MCP Tunnel client setup. It does not replace or remove other supported ways of exposing Portus MCP, such as Tailscale Funnel, Cloudflare Tunnel, or other reverse tunnel methods.

## What `tunnel-client` does

`Portus MCP` runs locally as an HTTP / Streamable HTTP MCP server.

By default, the local MCP endpoint is:

```text
http://127.0.0.1:8789/mcp
```

`tunnel-client` runs on the same machine, VM, or trusted network as Portus MCP and forwards traffic through an OpenAI Secure MCP Tunnel.

The basic local setup is:

```text
Portus MCP -> tunnel-client -> OpenAI Secure MCP Tunnel
```

Portus MCP still runs locally. `tunnel-client` is the process that connects the local MCP server to the OpenAI tunnel.

## Important values

This setup uses three different values that should not be confused.

| Value | Used by | What it is |
|---|---|---|
| `CONTROL_PLANE_API_KEY` | `tunnel-client` | A regular OpenAI Platform API key from the OpenAI Platform API keys page. It usually starts with `sk-...`. |
| `tunnel_id` | `tunnel-client` | The tunnel ID created in OpenAI Platform tunnel settings. It usually starts with `tunnel_...`. |
| `PORTUS_MCP_BEARER_TOKEN` | Portus MCP direct clients | Optional static bearer token for direct MCP clients that support bearer auth. It is not the OpenAI API key. |

Do not put the tunnel ID in `CONTROL_PLANE_API_KEY`.

Do not put the OpenAI Platform API key in `PORTUS_MCP_BEARER_TOKEN`.

Do not put `PORTUS_MCP_BEARER_TOKEN` in the `tunnel-client` profile.

For the OpenAI tunnel-client flow, `CONTROL_PLANE_API_KEY` must be a regular OpenAI Platform API key.

## Requirements

You need:

```text
- Node.js 20 or newer
- npm
- Git
- a working Portus MCP checkout
- an OpenAI Platform account
- an OpenAI Platform tunnel
- a regular OpenAI Platform API key
- the tunnel-client executable
```

Useful links:

```text
OpenAI Secure MCP Tunnel docs:
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

OpenAI tunnel management:
https://platform.openai.com/settings/organization/tunnels

OpenAI API keys:
https://platform.openai.com/settings/organization/api-keys

tunnel-client releases:
https://github.com/openai/tunnel-client/releases
```

## Setup order

Use this order:

```text
1. Download tunnel-client.
2. Place tunnel-client somewhere permanent.
3. Create or verify the tunnel in OpenAI Platform.
4. Copy the tunnel ID.
5. Create or copy a regular OpenAI Platform API key.
6. Set that API key as CONTROL_PLANE_API_KEY.
7. Start Portus MCP locally.
8. Initialize the tunnel-client profile with --mcp-server-url.
9. Validate the profile with doctor.
10. Run tunnel-client.
```

## 1. Download `tunnel-client`

Open:

```text
https://github.com/openai/tunnel-client/releases
```

Download the correct release for your operating system.

For a normal 64-bit Windows PC, download the Windows `amd64` zip, for example:

```text
tunnel-client-v0.0.10-windows-amd64.zip
```

Notes:

```text
amd64 = normal 64-bit Intel/AMD machine
arm64 = ARM machine
```

The zip contains an executable. There is no installer.

On Windows, the executable is:

```text
tunnel-client.exe
```

If you double-click the executable, it may show a message saying it is a command-line tool. That is expected. Run it from PowerShell or `cmd.exe`.

## 2. Place `tunnel-client.exe` somewhere permanent

On Windows, a simple location is:

```text
C:\tools\tunnel-client\tunnel-client.exe
```

Create the folder:

```powershell
mkdir C:\tools\tunnel-client
```

Extract or move `tunnel-client.exe` into that folder.

Then test it:

```powershell
cd C:\tools\tunnel-client
.\tunnel-client.exe --help
```

If it prints command help, the binary is working.

## 3. Create a tunnel on OpenAI Platform

Open:

```text
https://platform.openai.com/settings/organization/tunnels
```

Create a new tunnel.

Copy the tunnel ID. It looks like:

```text
tunnel_...
```

You will use this tunnel ID when creating the local `tunnel-client` profile.

The tunnel ID is not an API key.

## 4. Create or copy an OpenAI Platform API key

Open:

```text
https://platform.openai.com/settings/organization/api-keys
```

Create or copy a normal OpenAI Platform API key.

This key is used by `tunnel-client` as:

```text
CONTROL_PLANE_API_KEY
```

This is a regular OpenAI Platform API key. It usually starts with:

```text
sk-...
```

It is not the same as:

```text
PORTUS_MCP_BEARER_TOKEN
```

It is not the same as:

```text
tunnel_...
```

## 5. Set `CONTROL_PLANE_API_KEY` permanently on Windows

Set the OpenAI Platform API key permanently as a user environment variable:

```powershell
setx CONTROL_PLANE_API_KEY "sk-your-openai-platform-api-key"
```

Close the current terminal and open a new PowerShell window.

Test:

```powershell
echo $env:CONTROL_PLANE_API_KEY
```

Important: `setx` only affects new terminals. The terminal where you ran `setx` will not automatically see the new value.

You can also set it temporarily for only the current PowerShell session:

```powershell
$env:CONTROL_PLANE_API_KEY="sk-your-openai-platform-api-key"
```

## 6. Prepare Portus MCP

From the Portus MCP repo:

```powershell
npm install
copy .env.example .env
notepad .env
```

At minimum, set your project list:

```env
PORTUS_MCP_PROJECTS=app=C:/path/to/project
```

For several projects, list them on separate lines inside quotes (or separate with newlines/pipes/semicolons):

On Windows:
```env
PORTUS_MCP_PROJECTS="
  app=C:\path\to\app
  api=C:\path\to\api
"
```

On Linux:
```env
PORTUS_MCP_PROJECTS="
  app=/home/user/projects/app
  api=/home/user/projects/api
"
```
`PORTUS_MCP_BEARER_TOKEN` is optional Portus MCP configuration for direct clients that support bearer auth. It is not used as the `tunnel-client` API key.

## 7. Start Portus MCP

In Terminal 1:

```powershell
cd C:\path\to\portus-mcp
npm start
```

Expected output:

```text
portus-mcp MCP server listening on http://localhost:8789/mcp
```

Leave this terminal running.

The local MCP endpoint is:

```text
http://127.0.0.1:8789/mcp
```

The local health endpoint is:

```text
http://127.0.0.1:8789/
```

You can check the server with:

```powershell
curl.exe http://127.0.0.1:8789/
curl.exe http://127.0.0.1:8789/mcp
```

## 8. Create the `tunnel-client` profile

In Terminal 2:

```powershell
cd C:\tools\tunnel-client
```

Create the profile:

```powershell
.\tunnel-client.exe init `
  --profile portus-local `
  --tunnel-id tunnel_your_tunnel_id `
  --mcp-server-url "http://127.0.0.1:8789/mcp"
```

Replace:

```text
tunnel_your_tunnel_id
```

with the tunnel ID from OpenAI Platform.

Do not use:

```powershell
--sample sample_mcp_stdio_local
```

That sample is for stdio MCP servers and requires:

```powershell
--mcp-command
```

Portus MCP is an HTTP / Streamable HTTP MCP server, so use:

```powershell
--mcp-server-url "http://127.0.0.1:8789/mcp"
```

A successful profile creation should look similar to:

```text
Created profile portus-local at C:\Users\<user>\AppData\Roaming\tunnel-client\portus-local.yaml
Sample: sample_mcp_with_dcr
Next:
  tunnel-client doctor --profile portus-local
  tunnel-client run --profile portus-local
```

## 9. Validate the tunnel profile

Keep Portus MCP running in Terminal 1.

In Terminal 2, run:

```powershell
.\tunnel-client.exe doctor --profile portus-local --explain
```

Important checks:

```text
CHECK profile_load             PASS
CHECK tunnel_id                PASS
CHECK control_plane_api_key    PASS
CHECK mcp_target               PASS http://127.0.0.1:8789/mcp
CHECK mcp_server_reachable     PASS HTTP 200 from http://127.0.0.1:8789/mcp
CHECK health_listener          PASS
CHECK ui                       PASS
```

If `control_plane_api_key` fails, check `CONTROL_PLANE_API_KEY`.

If `mcp_server_reachable` fails, check that `npm start` is still running and that Portus MCP is listening on:

```text
http://127.0.0.1:8789/mcp
```

## 10. Run the tunnel daemon

In Terminal 2:

```powershell
.\tunnel-client.exe run --profile portus-local
```

This prints JSON logs. That is normal.

Leave this terminal running.

For discovery and MCP tool calls through the tunnel, both processes must remain open:

```text
Terminal 1: Portus MCP
Terminal 2: tunnel-client
```

## 11. Check local tunnel-client health

In a third terminal, check:

```powershell
curl.exe http://127.0.0.1:8080/healthz
```

Expected output:

```text
live
```

You can also open the local tunnel-client UI:

```text
http://127.0.0.1:8080/ui
```

A healthy setup should show something like:

```text
Health: live
Ready: ready
Channel main: enabled
Server: external
Transport: http-streamable
Proxy: direct
```

The admin UI is local. It is for checking whether `tunnel-client` is healthy, ready, and connected.

## 12. Daily workflow

### Option A: Single-Command Launcher (Recommended)

Run both Portus MCP and `tunnel-client` together in one terminal:

```powershell
cd C:\path\to\portus-mcp
npm run start:tunnel
```
*(Press `Ctrl+C` once to stop both processes cleanly).*

### Option B: Two-Terminal Setup (Alternative)

Terminal 1 (Portus MCP):

```powershell
cd C:\path\to\portus-mcp
npm start
```

Terminal 2 (`tunnel-client`):

```powershell
cd C:\tools\tunnel-client
.\tunnel-client.exe run --profile portus-local
```

Both processes must stay running while an MCP client uses the tunnel.
## Troubleshooting

### `tunnel-client` says the API key is not set

Set it permanently:

```powershell
setx CONTROL_PLANE_API_KEY "sk-your-openai-platform-api-key"
```

Then close and reopen PowerShell.

Check:

```powershell
echo $env:CONTROL_PLANE_API_KEY
```

Remember:

```text
CONTROL_PLANE_API_KEY = regular OpenAI Platform API key
```

It is not the tunnel ID.

### `sample_mcp_stdio_local requires --mcp-command`

Do not force the stdio sample.

Use:

```powershell
.\tunnel-client.exe init `
  --profile portus-local `
  --tunnel-id tunnel_your_tunnel_id `
  --mcp-server-url "http://127.0.0.1:8789/mcp"
```

Portus MCP is an HTTP / Streamable HTTP MCP server, not a stdio MCP server.

### `mcp_server_reachable` fails

Make sure Portus MCP is running:

```powershell
cd C:\path\to\portus-mcp
npm start
```

Then check:

```powershell
curl.exe http://127.0.0.1:8789/
curl.exe http://127.0.0.1:8789/mcp
```

If Portus MCP is listening on a different host or port, recreate or update the tunnel profile with the correct `--mcp-server-url`.

### `control_plane_api_key` fails

Check that the current terminal can see the environment variable:

```powershell
echo $env:CONTROL_PLANE_API_KEY
```

If it is empty, either reopen PowerShell after using `setx`, or set it temporarily:

```powershell
$env:CONTROL_PLANE_API_KEY="sk-your-openai-platform-api-key"
```

Then run:

```powershell
.\tunnel-client.exe doctor --profile portus-local --explain
```

### `http://127.0.0.1:8080/ui` does not open

Make sure `tunnel-client run` is still running.

Check:

```powershell
curl.exe http://127.0.0.1:8080/healthz
```

If the health listener is on a different port, check the `tunnel-client run` logs or recreate the profile with the desired health listener address.

### Tool calls through the tunnel fail

Check the two local processes first:

```text
Terminal 1: Portus MCP must still be running.
Terminal 2: tunnel-client must still be running.
```

Then check the tunnel health:

```powershell
curl.exe http://127.0.0.1:8080/healthz
```

And the Portus MCP health endpoint:

```powershell
curl.exe http://127.0.0.1:8789/
```

## Summary

Keep the values clear:

```text
CONTROL_PLANE_API_KEY = regular OpenAI Platform API key for tunnel-client
tunnel_id = OpenAI Platform tunnel ID used by tunnel-client
PORTUS_MCP_BEARER_TOKEN = optional Portus MCP bearer token for direct clients
```

Daily use requires two running processes:

```text
Terminal 1: npm start
Terminal 2: tunnel-client run --profile portus-local
```
