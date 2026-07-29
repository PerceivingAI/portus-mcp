# Tailscale Integration & Setup Guide

This guide is the authoritative reference for setting up, configuring, and using **Tailscale** (Tailscale Serve & Tailscale Funnel) with **Portus MCP**.

---

## 1. Overview & Architecture

Portus MCP runs locally as a Streamable HTTP Model Context Protocol server.

* **Default Local Endpoint**: `http://127.0.0.1:8789/mcp`
* **Local Protocol**: Remains plain `http://` because loopback (`127.0.0.1`) traffic is memory-isolated within the host OS kernel. External proxies handle TLS at the network/cloud edge.
* **Compatibility Invariant**: Tailscale integrations work in parallel with OpenAI `tunnel-client` without requiring changes to local `tunnel-client` daily workflows.
* **Authentication**: Bearer authentication (`PORTUS_MCP_BEARER_TOKEN`) is strictly **optional**.

---

## 2. Choosing Between Serve and Funnel

Tailscale offers two distinct ways to expose Portus MCP:

| Feature | Tailscale Serve (`tailscale serve 8789`) | Tailscale Funnel (`tailscale funnel 8789`) |
|---|---|---|
| **Access Scope** | 100% Private (Logged-in devices on your Tailnet) | Public Internet (Proxied via Tailscale edge) |
| **Use Case** | Local IDEs (Codex Desktop, Cursor), secondary laptops, mobile devices | Third-party cloud connectors (Perplexity Custom Connectors, webhooks) |
| **TLS / HTTPS** | Automatic valid Let's Encrypt certificates | Automatic valid Let's Encrypt certificates |
| **Reachability by Perplexity** | ❌ Unreachable (Cloud servers are not in your Tailnet) | ✅ Reachable |

---

## 3. Tailscale Serve (Private Inter-Device Mesh)

Use **Tailscale Serve** to connect to Portus MCP from your other personal devices (laptops, tablets, secondary workstations) without exposing port `8789` to the public internet.

### Quick Setup

#### Option A: Single-Command Launcher (Recommended)
```bash
npm run start:serve
```
*(Spawns both Portus MCP and `tailscale serve 8789` together in one terminal).*

#### Option B: Two-Terminal Setup
1. Terminal 1: `npm start`
2. Terminal 2: `tailscale serve 8789`
3. Copy the private HTTPS URL displayed:
   ```text
   https://<machine-name>.<tailnet-name>.ts.net/mcp
   ```
4. Enter this URL into Codex Desktop, Cursor, or your secondary device's MCP client configuration.

### Stopping Serve
```bash
tailscale serve off
```

---

## 4. Tailscale Funnel (Public Cloud Connectors & Perplexity)

Use **Tailscale Funnel** when a cloud-hosted service (such as **Perplexity AI Custom Remote Connectors**) needs inbound HTTPS access to your local Portus MCP server.

### Quick Setup for Perplexity

#### Option A: Single-Command Launcher (Recommended)
```bash
npm run start:funnel
```
*(Spawns both Portus MCP and `tailscale funnel 8789` together in one terminal).*

#### Option B: Two-Terminal Setup
1. Terminal 1: `npm start`
2. Terminal 2: `tailscale funnel 8789`
3. Copy the public HTTPS URL displayed by Tailscale:
   ```text
   https://<machine-name>.<tailnet-name>.ts.net/mcp
   ```
4. In Perplexity AI:
   * Go to **Settings** -> **Connectors** -> **Add Custom Remote Connector**.
   * Set **URL**: `https://<machine-name>.<tailnet-name>.ts.net/mcp`
   * Set **Auth**: Select *No Auth* (or *Bearer Token* if `PORTUS_MCP_BEARER_TOKEN` is configured).

### Path-Based Obscurity for No-Auth Funnels
If you use Funnel without a Bearer token, you can prevent automated web crawlers from discovering `/mcp` by setting a secret route path in `.env`:

```env
PORTUS_MCP_PATH=/secret-key-1234/mcp
```

* **Client URL**: `https://<machine-name>.<tailnet-name>.ts.net/secret-key-1234/mcp`
* **Harness Compatibility**: The URL ends in `/mcp`, satisfying client harnesses while returning `404 Not Found` to standard scanners hitting `/mcp`.

### Stopping Funnel
```bash
tailscale funnel off
```

---

## 5. Environment Variables

Portus MCP provides environment variables to tune network exposure and paths:

| Environment Variable | Default | Purpose |
|---|---|---|
| `PORTUS_MCP_HOST` | `127.0.0.1` | Host adapter binding. Confines unencrypted HTTP to loopback, blocking raw physical LAN exposure. |
| `PORTUS_MCP_PORT` | `8789` | Local TCP port for the HTTP MCP server. |
| `PORTUS_MCP_PATH` | `/mcp` | Base HTTP path for MCP routes. Supports secret paths (e.g. `/secret-key/mcp`). |
| `PORTUS_MCP_BEARER_TOKEN` | *(empty)* | Optional static bearer token. Left empty for No-Auth client flows. |

---

## 6. Tailscale Status & Endpoint Helper (`npm run tailscale:status`)

Portus MCP includes a CLI status helper script to inspect your active Tailscale configuration:

```bash
npm run tailscale:status
```

### Example Output
```text
==================================================
  Portus MCP - Tailscale Status Summary
==================================================
Portus MCP State: Listening on http://127.0.0.1:8789/mcp
Configured Path:  /mcp
Tailscale Status: Connected (desktop-main.tail1234.ts.net)
Exposure Mode:    PUBLIC FUNNEL (tailscale funnel)
Target URL:       https://desktop-main.tail1234.ts.net/mcp
Status:           Ready for external cloud connectors (e.g. Perplexity).
==================================================
```

This helper automatically detects whether Tailscale is running, checks if Serve or Funnel is active on port `8789`, and outputs ready-to-copy target URLs.

---

## 7. Identity Auditing (`Tailscale-User-Login`)

When requests pass through Tailscale Serve or Funnel, Tailscale automatically injects identity headers into incoming HTTP requests:
* `Tailscale-User-Login` (e.g., `alice@example.com` or `github:alice`)
* `Tailscale-User-Name` (e.g., `Alice Smith`)

Portus MCP inspects these headers and records them in session audit logs (`SessionEvents`), providing cryptographic identity traceability without forcing user login prompts or Bearer tokens. Requests originating from local clients (`tunnel-client`, local IDEs) without these headers process normally without interruption.

---

## 8. Optional Tailscale Admin Console Hardening

ACL policies and HTTPS certificate settings in Tailscale are 100% optional (Funnel works out-of-the-box for Tailnet administrators). If you wish to restrict Funnel creation privileges or manage HTTPS certificates explicitly:

### 1. Enable HTTPS Certificates
In [Tailscale Admin Console](https://login.tailscale.com/admin/) -> **DNS**, scroll to **HTTPS Certificates** and click **Enable**.

### 2. Configure ACL Node Attributes
In **Access Controls** (ACLs), add the `nodeAttrs` section:
```json
"nodeAttrs": [
  {
    "target": ["autogroup:admin"],
    "attr":   ["funnel"]
  }
]
```
This policy rule ensures only designated Tailnet administrators can spin up public Funnels.

---

## 9. Summary & Best Practices

1. **Keep Local Host as `127.0.0.1`**: Keeps loopback memory-isolated while external proxies handle HTTPS edge encryption.
2. **Daily Driver (`tunnel-client`)**: Leave `tunnel-client` connecting locally to `http://127.0.0.1:8789/mcp` for ChatGPT daily use.
3. **Use Tailscale Serve for Private Devices**: Run `tailscale serve 8789` for laptops, phones, or Cursor/Codex Desktop on other machines.
4. **Use Tailscale Funnel for Perplexity**: Run `tailscale funnel 8789` when exposing an endpoint to cloud AI agents like Perplexity.
5. **Inspect Status Anytime**: Run `npm run tailscale:status` to copy your complete target MCP URL.
