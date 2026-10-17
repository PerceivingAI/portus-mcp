# Tailscale Integration & Setup Guide

**Updated:** 2026-10-17T06:14:05Z

This guide is the authoritative reference for setting up, configuring, and using **Tailscale** (Tailscale Serve & Tailscale Funnel) with **Portus MCP**.

---

## 1. Overview & Architecture

Portus MCP runs locally as a Streamable HTTP Model Context Protocol server.

* **Default Local Endpoint**: `http://127.0.0.1:8789/mcp`
* **Local Protocol**: Remains plain `http://` because loopback (`127.0.0.1`) traffic is memory-isolated within the host OS kernel. External proxies handle TLS at the network/cloud edge.
* **Compatibility Invariant**: Tailscale integrations work in parallel with OpenAI `tunnel-client` without requiring changes to local `tunnel-client` daily workflows.
* **Authentication**: Bearer authentication (`PORTUS_MCP_BEARER_TOKEN`) is optional for private Serve/tunnel usage, but strongly recommended when exposing Portus to the public internet via Tailscale Funnel.
---

## 2. Choosing Between Serve and Funnel

Tailscale offers two distinct ways to expose Portus MCP:

| Feature | Tailscale Serve (`tailscale serve 8789`) | Tailscale Funnel (`tailscale funnel 8789`) |
|---|---|---|
| **Access Scope** | 100% Private (Logged-in devices on your Tailnet) | Public Internet (Proxied via Tailscale edge) |
| **Tailscale Identity Headers** | ✅ Injected (`Tailscale-User-Login`, `Tailscale-User-Name`) | ❌ Not injected (Public visitors have no Tailnet identity) |
| **Use Case** | Local IDEs (Codex Desktop, Cursor), secondary laptops, mobile devices | Third-party cloud connectors (Perplexity Custom Remote Connectors) |
| **TLS / HTTPS** | Valid HTTPS certificates after HTTPS is enabled for the tailnet | Valid HTTPS certificates after MagicDNS, HTTPS, and Funnel permissions are enabled |
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

### Stopping or Resetting Serve
```bash
tailscale serve off
```
*Note: Serve and Funnel cannot be concurrently configured on the same port. Running `tailscale serve 8789` will replace any existing Funnel configuration on port 8789.*

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
   * Set **Auth**: Select *Bearer Token* and enter your configured `PORTUS_MCP_BEARER_TOKEN`.
   * Do not select *No Auth* for a public Funnel endpoint except during a brief, controlled protocol test with no sensitive, privileged, or action-capable tools exposed.

### Development-Only Path Obscurity
If you test Funnel without a Bearer token, setting a secret route path in `.env` reduces automated scanner traffic:

```env
PORTUS_MCP_PATH=/secret-key-1234/mcp
```

* **Client URL**: `https://<machine-name>.<tailnet-name>.ts.net/secret-key-1234/mcp`
* **Security Notice**: A secret route path is **not authentication**. Secret paths can leak in browser history, logs, referrers, error reports, or screenshots. Do not rely on secret paths alone as security for endpoints with sensitive tool capabilities. Require a strong `PORTUS_MCP_BEARER_TOKEN` or OAuth for production deployment.

### Stopping or Resetting Funnel
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
| `PORTUS_MCP_BEARER_TOKEN` | *(empty)* | Static bearer token. Recommended for public Funnel endpoints. |
| `PORTUS_TAILSCALE_PATH` | PATH, then supported installation locations | Explicit Tailscale executable override, shared by startup and status. An invalid override fails instead of silently selecting another installation. |
| `PORTUS_MCP_FORWARD_EXTERNAL_LOGS` | Disabled | Tailscale essential diagnostics remain visible when disabled. Enabling it adds bounded diagnostic categories, not raw CLI output. OpenAI logging behavior is unchanged. |

### Secure Configuration Example

Generate a long, random secret token:
```bash
openssl rand -base64 32
```

Set the token in your local `.env`:
```env
PORTUS_MCP_HOST=127.0.0.1
PORTUS_MCP_PORT=8789
PORTUS_MCP_PATH=/mcp
PORTUS_MCP_BEARER_TOKEN=replace-with-a-long-random-secret
```
*(Do not commit `.env` to git repository. Portus automatically redacts `Authorization` headers from session audit logs).*

## 6. Tailscale status and endpoint helper

Inspect the configured Portus endpoint without enabling Serve/Funnel or changing the daemon:

```bash
npm run tailscale:status
```

For structured output:

```bash
npm run tailscale:status -- --json
```

The helper records observation timestamps and separates these claims:

| Observation | Meaning |
| --- | --- |
| Daemon | `connected` requires Running, Online true, and a usable DNS name. `not-ready` and `unknown` are not success. |
| Portus route | `configured` requires a matching hostname, HTTPS listener, mount/path, and backend. Exposure is public only when the matching `AllowFunnel` boolean is true. Foreground/background scope is reported, but ownership is not verified. |
| Absent/mismatched route | Empty recognized configuration and unrelated configuration are distinct. Neither supplies a Portus URL. Malformed, unsupported, or ambiguous configuration is reported without guessing an endpoint. |
| Local MCP | `verified` means authenticated local initialization, initialized notification, and tool discovery succeeded. This invokes no tools. A root health payload is insufficient. |
| Public MCP | Always `not-checked` by this helper. Public proof requires an authenticated probe from outside the tailnet and actual-client validation. |

Configured URLs include the actual listener port when non-default. Mount prefixes and proxy target paths are accounted for, including more-specific handlers that shadow another route. Tailnet Services and unknown configuration extensions are conservatively unsupported rather than treated as ready.

Status commands and the entire local protocol probe each have a five-second deadline and run concurrently. CLI output is limited to 256 KiB per captured stream; local JSON responses are limited to 1 MiB. Missing executables, command failures, timeouts, and malformed output remain explicit errors. Unsupported local endpoints are not probed with credentials.

Exit code `0` means the daemon is connected, the intended route is configured, and local MCP is verified. It does **not** mean the public endpoint works. Other outcomes return `1`. A bearer being configured does not prove compatibility with a URL client.

Tailscale launcher output retains startup, failure, and closure diagnostics even with verbose forwarding disabled. It emits fixed categories rather than raw external text, deduplicates them, caps each child at 16 diagnostic categories, and bounds pending input to 4 KiB per stream. Raw credentials, identities, URLs, and local paths are withheld even in verbose mode. Configured endpoint URLs in intentional status output still contain the hostname/path; treat that output as private.

These are diagnostic fixes only. They add no automatic restart, attach-only mode, persistent route, public authentication design, or claim of continuous reachability.

---

## 7. Identity Auditing (`Tailscale-User-Login`)

Tailscale Serve injects verified identity headers for requests coming from devices signed into your Tailnet:
* `Tailscale-User-Login` (e.g., `alice@example.com` or `github:alice`)
* `Tailscale-User-Name` (e.g., `Alice Smith`)

Portus MCP inspects these headers and records them in session audit logs (`SessionEvents`), providing cryptographic identity traceability for private inter-device mesh requests.

**Important Note for Funnel Traffic**: Tailscale Funnel proxies public internet traffic and **does not inject Tailscale identity headers**. Funnel requests process as anonymous at the network layer; Portus relies on `PORTUS_MCP_BEARER_TOKEN` or application credentials to authenticate and authorize Funnel requests.

## 8. Tailscale Prerequisites & Admin Console Policy

Tailscale Funnel requires **MagicDNS**, **HTTPS Certificates**, and the **`funnel`** node attribute in your Tailscale ACL policy.

### 1. Enable MagicDNS & HTTPS Certificates
In the [Tailscale Admin Console](https://login.tailscale.com/admin/):
1. Go to **DNS** -> enable **MagicDNS**.
2. Scroll to **HTTPS Certificates** -> click **Enable**.

### 2. Configure ACL Node Attributes
In **Access Controls** (ACLs), grant `funnel` capability to designated nodes:

```json
"nodeAttrs": [
  {
    "target": ["tag:portus-mcp"],
    "attr":   ["funnel"]
  }
]
```
*(Using a specific tag like `tag:portus-mcp` restricts Funnel creation to the dedicated Portus host rather than all administrator personal nodes).*

---

## 9. Verifying External Endpoint Reachability

After starting `npm run start:funnel` (or `tailscale funnel 8789`), verify reachability from an external network (e.g., a phone connected via cellular data outside your Tailnet):

### 1. Test HTTPS Handshake
```bash
curl -i https://<machine-name>.<tailnet-name>.ts.net/mcp
```
*(An unauthenticated call to a protected server should return `401 Unauthorized`).*

### 2. Test Authenticated Request
```bash
curl -i \
  -H "Authorization: Bearer $PORTUS_MCP_BEARER_TOKEN" \
  https://<machine-name>.<tailnet-name>.ts.net/mcp
```
*(This verifies public DNS, TLS, routing, and authentication. Depending on the Streamable HTTP MCP implementation, a bare curl request may return 200, 405, 406, or an MCP-specific response; validate tool discovery with an MCP client.)*
---

## 10. Summary & Best Practices

1. **Keep Local Host as `127.0.0.1`**: Keeps loopback memory-isolated while external proxies handle HTTPS edge encryption.
2. **Daily Driver (`tunnel-client`)**: Leave `tunnel-client` connecting locally to `http://127.0.0.1:8789/mcp` for ChatGPT daily use.
3. **Use Tailscale Serve for Private Devices**: Run `tailscale serve 8789` for laptops, phones, or Cursor/Codex Desktop on other machines. Tailscale identity headers apply here.
4. **Use Tailscale Funnel for Perplexity**: Run `tailscale funnel 8789` when exposing an endpoint to cloud AI agents like Perplexity. Require a `PORTUS_MCP_BEARER_TOKEN`.
5. **Secret Paths Are Not Auth**: Do not rely on secret paths alone to protect endpoints with sensitive tool access.
6. **Inspect Status Anytime**: Run `npm run tailscale:status` to inspect your active configuration.

