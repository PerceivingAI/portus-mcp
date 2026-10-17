# Tailscale Integration & Setup Guide

**Updated:** 2026-10-17T09:33:09Z

This guide is the authoritative reference for setting up, configuring, and using **Tailscale** (Tailscale Serve & Tailscale Funnel) with **Portus MCP**.

---

## 1. Overview & Architecture

Portus MCP runs locally as a Streamable HTTP Model Context Protocol server.

* **Default Local Endpoint**: `http://127.0.0.1:8789/mcp`
* **Local protocol**: The backend uses plain HTTP on loopback. For Serve/Funnel, HTTPS terminates in the local Tailscale daemon, not at the public Funnel relay. The relay forwards encrypted TCP.
* **Standalone ownership**: Each `start:tunnel`, `start:serve`, or `start:funnel` wrapper starts and owns its own backend. Do not run two standalone wrappers against the same bind/port. OpenAI's default command and authentication contract remain unchanged.
* **Attach-only ownership**: `attach:serve` and `attach:funnel` expose an existing backend without starting another MCP server or `tunnel-client`. Closing the companion leaves that backend and its owning launcher running.
* **Authentication**: Bearer authentication (`PORTUS_MCP_BEARER_TOKEN`) is optional in every mode, including public Funnel. When configured, both the companion's initial protocol check and clients must use the configured bearer. Without application authentication, a publicly reachable Funnel endpoint makes the exposed tools available to public callers.
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

The standalone wrapper requires `PORTUS_MCP_HOST=127.0.0.1`, a connected daemon, and no existing configuration on external listener `443`. It refuses unknown configuration, occupied listeners, and borrowed backends, even when they appear to be another Portus instance. A private IPC acknowledgement from the spawned backend must confirm its bound listener before exposure starts.

#### Option B: Attach to an Existing Backend
1. Terminal 1: keep `npm run start:tunnel` running, or start Portus separately with `npm start`.
2. Terminal 2: `npm run attach:serve`.
3. Run `npm run tailscale:status` to read the configured private HTTPS URL. Its default shape is:
   ```text
   https://<machine-name>.<tailnet-name>.ts.net/mcp
   ```
4. Enter this URL into Codex Desktop, Cursor, or your secondary device's MCP client configuration.

### Stopping Serve safely

Press Ctrl+C in the owning launcher terminal. The wrapper awaits termination of its owned process trees and release of its foreground watch-session configuration, with a five-second teardown deadline. If confirmation fails, it reports failure; it does not reset the daemon or delete unrelated routes.

For attach-only operation, Ctrl+C in terminal 2 stops only the owned Tailscale CLI and foreground route. It never stops the borrowed backend or `tunnel-client`. Direct manual CLI operation remains possible but does not inherit launcher checks. Do not use global Serve/Funnel reset/off commands as routine recovery.

Serve and Funnel cannot share the same external listener, normally `443`. Backend port `8789` is not that listener. The wrapper refuses to replace existing listener configuration; direct manual CLI commands do not inherit these launcher guards.

---

## 4. Tailscale Funnel (Public Cloud Connectors & Perplexity)

Use **Tailscale Funnel** when a cloud-hosted service (such as **Perplexity AI Custom Remote Connectors**) needs inbound HTTPS access to your local Portus MCP server.

### Quick Setup for Perplexity

#### Option A: Single-Command Launcher (Recommended)
```bash
npm run start:funnel
```
*(Spawns both Portus MCP and `tailscale funnel 8789` together in one terminal).*

This is standalone operation with the same loopback, connected-daemon, free-listener, and owned-backend requirements as Serve. Starting this wrapper alongside an OpenAI wrapper on the same backend port is not an attach workflow; use `attach:funnel` below. Authentication remains optional, and actual-client compatibility requires separate verification.

#### Option B: Attach to an Existing Backend
1. Terminal 1: keep `npm run start:tunnel` running, or start Portus separately with `npm start`.
2. Terminal 2: `npm run attach:funnel`.
3. Run `npm run tailscale:status` to read the configured public HTTPS URL. Its default shape is:
   ```text
   https://<machine-name>.<tailnet-name>.ts.net/mcp
   ```
4. In Perplexity AI:
   * Go to **Settings** -> **Connectors** -> **Add Custom Remote Connector**.
   * Set **URL**: `https://<machine-name>.<tailnet-name>.ts.net/mcp`
   * Set **Auth** to *Bearer Token* when `PORTUS_MCP_BEARER_TOKEN` is configured, and supply the same token.
   * Otherwise use the client's unauthenticated option. Application authentication is optional; without it, anyone who can reach the public endpoint can access the exposed tools.

### Development-Only Path Obscurity
If you test Funnel without a Bearer token, setting a secret route path in `.env` reduces automated scanner traffic:

```env
PORTUS_MCP_PATH=/secret-key-1234/mcp
```

* **Client URL**: `https://<machine-name>.<tailnet-name>.ts.net/secret-key-1234/mcp`
* **Security Notice**: A secret route path is **not authentication**. The root health response advertises the configured MCP path, and paths can also leak through logs, history, or screenshots. A bearer is optional; configure one if you want application-level access control.

### Stopping Funnel safely

Press Ctrl+C in the terminal that owns foreground Funnel. The launcher waits for its owned process trees and observed foreground session to disappear within the five-second teardown budget. It never uses a global reset/off command to remove another service.

No `--bg` flag or persistent route is added. Background services configured elsewhere remain their operator's responsibility. Manual CLI workflows must preserve unrelated listeners and must not start a second backend if Portus is already running.

### Attach-only operation and backend restarts

The companion initially verifies the configured loopback endpoint with MCP initialization, initialized notification, and tool discovery. A health response alone is insufficient. An unavailable/wrong backend, invalid configured bearer, occupied external listener, or unknown configuration prevents attachment without starting another backend.

After that verification and owned foreground-route confirmation succeed, the companion prints one message: `[orchestrator] Tailscale Funnel attached to the existing MCP backend. Press Ctrl+C to stop the companion.` Private Serve prints `Tailscale Serve` instead. The initial banner alone is not this confirmation; the message describes successful initial attachment, not continuous backend health or verified public reachability.

After attachment, the companion does not monitor backend lifetime or health. If you stop terminal 1, requests through Tailscale fail while MCP is down, but terminal 2 and its foreground route remain running. Restart terminal 1 at the same host, port, and MCP path; subsequent requests use the restarted backend and its updated project list. No restart or reattachment of terminal 2 is needed. Existing in-flight requests or streams can fail; they are not replayed, and client session resumption is not guaranteed.

Changing the backend host, port, or MCP path requires explicitly updating/restarting the companion and client configuration as applicable. If you change the optional bearer, clients also need the new credential. Stop terminal 2 manually when access is no longer needed, even if the backend is currently down. The companion does not restart the backend, `tunnel-client`, or Tailscale daemon.

The owned CLI's unexpected exit remains a companion failure with bounded owned cleanup. Backend downtime alone is not a companion failure. No periodic probes, recovery loop, `--bg`, or request replay is added.


### Startup and shutdown guarantees

- All Tailscale launcher modes accept the literal bind `127.0.0.1`; wildcard, `localhost`, and IPv6 binds are rejected because the port-only proxy target is IPv4 loopback.
- An occupied backend causes standalone startup failure, not adoption or termination of its listener. Attach-only commands instead verify the existing MCP endpoint and never take process ownership. Repeated attachment fails clearly when the external listener is already configured.
- Listener configuration is inspected before backend startup or initial attachment verification and again immediately before starting the foreground CLI. Startup tracks one newly observed matching foreground session and rejects ambiguous or changed unrelated configuration.
- Configuration reads and the CLI's write are not a cross-operator transaction. Do not concurrently reconfigure Serve/Funnel while a launcher is starting or stopping. Observed unrelated changes cause failure, not global rollback.
- Shutdown stops only child trees started by that launcher. Windows uses awaited tree termination; foreground release is then confirmed with bounded read-only configuration observations. No arbitrary process is adopted because it answers a health URL.
- These are local ownership guarantees. Actual daemon watch-session behavior, public reachability, and live OpenAI/client interoperability require the separately planned live verification. Windows process-tree and isolated route-fixture behavior were exercised; equivalent POSIX behavior was not exercised.
- Required owned backend/foreground-service exit or spawn error makes a standalone launcher failed, including unexpected exit zero. Attach-only commands own no backend and fail-stop only for their owned CLI or cleanup failure. Child events are monitored within a five-second detection bound; this is not continuous public-route or application-health polling.
- Intentional Ctrl+C/stop is distinct from dependency failure. Expected child exits during teardown do not turn a clean stop into failure or an existing failure into success.
- Teardown retains its separate five-second budget. On Windows, an already exited root uses bounded process snapshots and creation-time-checked native handles for eligible descendants. Ambiguous identity, inaccessible processes, or incomplete teardown produce explicit unverified cleanup and exit 1, not speculative PID termination or a clean-shutdown claim.
- The actual launcher exits nonzero on terminal dependency/cleanup failure. A returning dependency cannot restart a terminal launcher. No automatic recovery, daemon restart, authentication change, or tool-call replay is added; recovery remains separate I2 work.

### F3 local verification and limits

The approved affected checks passed after correcting startup error propagation and Windows orphan fixtures. Real Windows proof includes a descendant still serving after its root exited, its actual native termination, and an out-of-window candidate left alive. Other focused cases covered unexpected zero/signal exits, backend loss, unrelated-service preservation, explicit unverified cleanup, and intentional shutdown.

The real CLI smoke exited 1 and reported external failure/confirmed cleanup. Its wrapper failed an incidental punctuation assertion before its socket probe; the separately approved single later observation returned `ECONNREFUSED` for that recorded listener. Local acceptance uses this combined evidence, not a claimed passed wrapper or an immediate smoke teardown measurement. The plan/report preserve the original failures and approvals.

F1–F3 are complete locally, not end-to-end public hardening. Native Tailscale daemon/public-route behavior, actual clients/OpenAI interoperability, equivalent POSIX behavior, and latency improvements remain separately unverified. Cleanup uncertainty may leave resources behind; an explicit failure is not a guarantee that everything stopped.

### I1 local verification status

The focused invocation passed 62 checks, including both attach modes, real backend restart with updated synthetic project aliases through a local proxy, optional/configured authentication, cancellation, conflict refusal, independent teardown, and existing standalone regressions. Both actual npm attach commands passed rejection-only CLI smoke checks.

The independent lifecycle smoke passed after a separately approved correction to its throwaway harness. It used the production standalone and attach APIs, observed HTTP 502 while the backend was down, then read the changed project aliases after restarting the backend at the same endpoint with the companion unchanged. Manual companion stop preserved the backend and controlled tunnel fixture; final owned teardown removed temporary state. The original pre-execution harness syntax failure remains recorded. I1 is locally accepted; native Tailscale daemon/public-route behavior and an actual agent's continuation after an error remain unverified. See [the I1 evidence](../notes/TUNNEL_REPORT.md#i1-attach-only-implementation-evidence) for outcomes and proof limits.


---

## 5. Environment Variables

Portus MCP provides environment variables to tune network exposure and paths:

| Environment Variable | Default | Purpose |
|---|---|---|
| `PORTUS_MCP_HOST` | `127.0.0.1` | Host adapter binding. Confines unencrypted HTTP to loopback, blocking raw physical LAN exposure. |
| `PORTUS_MCP_PORT` | `8789` | Local TCP port for the HTTP MCP server. |
| `PORTUS_MCP_PATH` | `/mcp` | Base HTTP path for MCP routes. Supports secret paths (e.g. `/secret-key/mcp`). |
| `PORTUS_MCP_BEARER_TOKEN` | *(empty)* | Optional static bearer token for any mode, including public Funnel. Attachment uses it only when configured. |
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
| Local MCP | `verified` means local initialization, initialized notification, and tool discovery succeeded, using a bearer only when configured. This invokes no tools. A root health payload is insufficient. |
| Public MCP | Always `not-checked` by this helper. Public proof requires a probe from outside the tailnet with the selected optional authentication configuration and actual-client validation. |

Configured URLs include the actual listener port when non-default. Mount prefixes and proxy target paths are accounted for. Handler selection follows Tailscale: an exact request path wins first; otherwise parent paths are checked from most specific to root, with the slash form before the non-slash form at each level. Non-slash mounts also handle descendant paths, and an unrelated handler in either form can shadow a matching root proxy. Tailnet Services and unknown configuration extensions are conservatively unsupported rather than treated as ready.

Status commands and the entire local protocol probe each have a five-second deadline and run concurrently. CLI output is limited to 256 KiB per captured stream; local JSON responses are limited to 1 MiB. Missing executables, command failures, timeouts, and malformed output remain explicit errors. Unsupported local endpoints are not probed with credentials.

Exit code `0` means the daemon is connected, the intended route is configured, and local MCP is verified. It does **not** mean the public endpoint works. Other outcomes return `1`. A bearer being configured does not prove compatibility with a URL client.

Tailscale launcher output retains startup, failure, and closure diagnostics even with verbose forwarding disabled. It emits fixed categories rather than raw external text, deduplicates them, caps each child at 16 diagnostic categories, and bounds pending input to 4 KiB per stream. Raw credentials, identities, URLs, and local paths are withheld even in verbose mode. Configured endpoint URLs in intentional status output still contain the hostname/path; treat that output as private.

The status helper alone does not prove runtime ownership. Standalone and attach-only launchers separately track their owned CLI and newly observed foreground session. Only standalone launchers own a backend; attach-only launchers leave the borrowed backend untouched. Neither status nor launcher configuration proof establishes public reachability. No persistence, mandatory authentication, or automatic recovery is added.

---

## 7. Identity Auditing (`Tailscale-User-Login`)

Tailscale Serve injects verified identity headers for requests coming from devices signed into your Tailnet:
* `Tailscale-User-Login` (e.g., `alice@example.com` or `github:alice`)
* `Tailscale-User-Name` (e.g., `Alice Smith`)

Portus MCP inspects these headers and records them in session audit logs (`SessionEvents`), providing cryptographic identity traceability for private inter-device mesh requests.

**Important Note for Funnel Traffic**: Tailscale Funnel proxies public internet traffic and does not inject Tailscale identity headers. Funnel callers have no verified tailnet identity. Optional application bearer authentication can restrict access; without it, the exposed tools accept unauthenticated public callers.

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

After starting `npm run start:funnel` or attaching with `npm run attach:funnel`, verify reachability in an approved live window from an external network, such as a phone on cellular data outside your tailnet:

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

1. **Keep Local Host as `127.0.0.1`**: Keep the backend on loopback; the local Tailscale daemon terminates external HTTPS.
2. **Daily Driver (`tunnel-client`)**: Leave `tunnel-client` connecting locally to `http://127.0.0.1:8789/mcp` for ChatGPT daily use.
3. **Use Tailscale Serve for Private Devices**: Run `tailscale serve 8789` for laptops, phones, or Cursor/Codex Desktop on other machines. Tailscale identity headers apply here.
4. **Use Tailscale Funnel for Perplexity**: Use `npm run attach:funnel` for an existing backend or `npm run start:funnel` for a standalone server. Bearer authentication remains optional.
5. **Secret Paths Are Not Auth**: Do not rely on secret paths alone to protect endpoints with sensitive tool access.
6. **Inspect Status Anytime**: Run `npm run tailscale:status` to inspect your active configuration.

