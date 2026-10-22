# Portus MCP

Portus MCP is a high-performance, policy-bounded MCP server for AI-assisted software engineering across local workstations, remote machines, and VMs. **Tools are policy-bounded adapters** where a connected agent interacts with pre-registered project workspaces through a unified, secure ten-tool surface.

---

## Tool Surface

Portus MCP exposes a fixed, high-leverage 10-tool surface:

| Tool Name | Key Parameters | Description |
| :--- | :--- | :--- |
| **`project_context`** | `projectAlias` (opt), `include` (opt) | Inspect project tree, scripts, git status, active policy capabilities, and registered aliases. |
| **`project_read`** | `requests[]` (`path`, `projectAlias`, `startLine`, `endLine`) | Batched ordered file reads with raw SHA-256 hashes and line-bounded slicing. |
| **`project_search`** | `requests[]` (`query`, `projectAlias`, `pathFilter`, `caseSensitive`) | Batched regex search across code files respecting `.gitignore`. |
| **`project_edit`** | `projectAlias`, `operations[]`, `batchMode` (opt) | Staged or ordered exact text replacement, range edits, and file/directory creation/deletion. |
| **`project_patch`** | `mode` (`prepare` \| `apply`), `patch`, `projectAlias` | Multi-file unified diff and structured hunk preparation and application with safety guards. |
| **`project_run`** | `projectAlias`, `requests[]` (`command`, `args`, `timeoutMs`) | Batched execution of allowlisted terminal commands with streaming process tracking. |
| **`project_policy`** | `operation` (`check_path`, `check_command`, `audit_log`, etc.) | Read-only policy inspection, path/command authorization pre-checks, and audit administration. |
| **`project_screenshot`**| `operation` (`capture_running`, `capture_launch`, `app_discovery`, etc.) | Session-owned GUI window capture and installed host application discovery. |
| **`subagent_task`** | `operation` (`spawn`, `steer`, `terminate`), `task`, `template` | Spawn, steer, and manage isolated Flue subprocess subagents. |
| **`subagent_context`** | `sessionId`, `include` (`status`, `events`, `output`, `artifacts`) | Inspect subagent execution state, streaming events, and output artifacts. |

---

## Quickstart Setup Guide

### 1. Install Dependencies

Clone the repository and install Node dependencies:

```bash
git clone https://github.com/PerceivingAI/portus-mcp.git
cd portus-mcp
npm install
```

> **Requirements**: Node.js `>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27` with bundled npm `11.19.1` from the pinned `24.22.1` runtime, and Git. `.nvmrc` and CI select `24.22.1`; do not bypass `engine-strict`.

---

### 2. Setup Transport Connection

Choose your preferred connection method:

#### Option A: OpenAI Secure MCP Tunnel (ChatGPT)
Run the interactive setup wizard to install `tunnel-client`, validate credentials, and initialize the profile:

```bash
npm run setup:tunnel
```
*Or run the platform script directly:*
- **Windows (PowerShell)**: `.\scripts\setup-tunnel.ps1`
- **Linux / macOS (Bash)**: `chmod +x ./scripts/setup-tunnel.sh && ./scripts/setup-tunnel.sh`

#### Option B: Tailscale (Private Mesh or Public Cloud)
Ensure Tailscale is installed and logged in on your machine. See [`docs/TAILSCALE.md`](./docs/TAILSCALE.md) for complete details.

---

### 3. Configure Projects & Security Policy

Portus MCP enforces strict, fail-closed multi-project confinement: **if no projects are registered, the agent has zero access to your machine.**

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

#### Pre-Registering Projects (`.env`)

Register your local project paths using `alias=path` format:

**Windows:**
```env
PORTUS_MCP_PROJECTS='
  web=C:\work\web-app
  api=C:\work\api-server
'
```

**Linux / macOS:**
```env
PORTUS_MCP_PROJECTS='
  web=/home/user/work/web-app
  api=/home/user/work/api-server
'
```

---

### 4. Launch Portus MCP

Use a standalone launcher to start a backend, or attach a Tailscale companion to an existing backend:

| Connection Target | Command | Description |
| :--- | :--- | :--- |
| **ChatGPT via OpenAI Tunnel** | `npm run start:tunnel` | Launches Portus MCP (`8789`) + `tunnel-client` daemon concurrently. |
| **Public Agents (Perplexity)** | `npm run start:funnel` | Launches Portus MCP + Tailscale Funnel for public cloud access. |
| **Private Mesh (Personal Devices)** | `npm run start:serve` | Launches Portus MCP + Tailscale Serve for private Tailnet access. |
| **Local HTTP Direct** | `npm start` | Launches the standalone HTTP server on `http://127.0.0.1:8789/mcp`. |
| **Private Mesh, Existing Backend** | `npm run attach:serve` | Starts only a Tailscale Serve companion for the configured backend. |
| **Public Agents, Existing Backend** | `npm run attach:funnel` | Starts only a Tailscale Funnel companion for the configured backend. |

Each standalone launcher owns its backend. Do not run two standalone launchers on the same host/port. To keep OpenAI and Tailscale on one backend, run `npm run start:tunnel` in terminal 1 and an `attach:*` command in terminal 2.

Press `Ctrl+C` to stop the processes owned by that launcher. Stopping an attach companion leaves the backend and OpenAI tunnel running. If you manually restart the backend at the same host, port, and MCP path, the companion stays running and subsequent requests reach the restarted backend. Failed or interrupted tool calls are not replayed.

MCP and new companions start only when explicitly launched. After a reboot, launch them again manually. Bearer authentication is optional in every mode, including Funnel; an unauthenticated public endpoint exposes its tools to anyone who can reach it. See [`docs/TAILSCALE.md`](./docs/TAILSCALE.md) for ownership and bounded attach-companion recovery.

---

### 5. Connect Agent

#### In ChatGPT (via Tunnel):
1. Navigate to **Settings** -> **Plugins (or Connectors)** -> **Browse plugins**.
2. Click **+** (add plugin), select **Tunnel**, and choose your configured tunnel device.
3. Select **No Auth**, accept the disclaimer, and click **Create** -> **Connect**.

#### In Other Clients (via Tailscale / Streamable HTTP):
Provide your public or mesh URL directly:
```text
https://machine.tailnet.ts.net/mcp
```

---

## Security & Operator Policies

### Policy Resolution (`portus-mcp.policy.json`)

Portus ships with `portus-mcp.policy.json` as its complete default policy. To maintain private operator settings without committing local paths or credentials to Git:
1. Copy `portus-mcp.policy.json` to **`portus-mcp.policy.local.json`** (automatically Git-ignored).
2. Set `PORTUS_MCP_POLICY_PATH=./portus-mcp.policy.local.json` in `.env`.
3. The selected policy file is a **strict replacement**, never an overlay.

The selected policy is validated once at backend startup and held as an immutable snapshot. External policy edits require an explicit backend restart; they do not change the running backend. `project_policy` is read-only and reports the effective policy, not pending file edits.

### Command Execution Allowlists

Portus enforces strict executable allowlisting under `main_agent.permissions.allowedCommands`:
- Specify **executable basenames only** (e.g., `["git", "cargo", "npm"]`).
- Omit OS-specific extensions (`.exe`, `.cmd`, `.bat`).
- Granting interpreters (`bash`, `powershell`, `python`, `node`) grants broad host authority under the Portus OS account.
- Spawned subagents use a separate, isolated allowlist under `subagents.permissions.allowedCommands`.

---

## Skills Catalog

Portus treats skills as read-only filesystem packages. Two independent audiences are configured via `.env`:

```env
AGENT_SKILL_PATHS=./skills
SUBAGENTS_SKILL_PATHS=./skills
```

- **`AGENT_SKILL_PATHS`**: Populates the skill catalog exposed to the connected MCP client via `project_context` with `include.skills=true`.
- **`SUBAGENTS_SKILL_PATHS`**: Populates the read-only `/skills/<name>` mounts available inside spawned Flue subagent workspaces.
- Multiple directories can be separated with semicolons.
- Skills are loaded as startup snapshots; restart Portus after modifying skills.

---

## Flue Subagent Workspaces

Spawned subagents (`subagent_task`) are autonomous processes executing inside ephemeral Flue workspaces:
- Isolated directory sandbox under `.portus-mcp/flue-workspaces/<sessionId>`.
- Granular permissions: `main_agent.permissions.subagentTask` controls lifecycle actions; `subagentContext` controls event and output retrieval.
- Subagents execute tasks with independent retry behavior configured in `portus-mcp.config.json`.

---

## Session-Owned Screenshots

The `project_screenshot` tool enables visual feedback and app interaction:
- **`app_discovery`**: Lists configured GUI apps installed on the host without exposing absolute paths.
- **`capture_running`**: Captures visible application windows owned by an active `project_run` execution session.
- **`capture_launch`**: Launches a configured application shortcut and captures its visible window.
- **`closeSession` requirement**: Must explicitly declare whether to terminate (`true`) or preserve (`false`) the target process tree.
- **Platform Support**: Native worker supports Windows, macOS, and Linux (X11). Wayland fails closed with `unsupported_session_window_capture`.

---

## Multi-Machine Infrastructure

Run Portus MCP across multiple machines simultaneously. Naming each MCP entry allows independent project roots and policies:

```text
Portus_Workstation  (Local Desktop)
Portus_LinuxVM      (Dev / Build VM)
Portus_RemoteGPU    (Compute Server)
```

The connected agent can switch across connections within the same conversation, with each node strictly bounded by its local policy.

---

## Testing & Validation

Run the comprehensive test suite covering tool contracts, permission gates, Git-ignore policies, screenshot attestation, and subagent lifecycles:

```bash
npm run check        # TypeScript typecheck
npm test             # Full test suite (265 tests)
npm run build        # Production build
npm run flue:check   # Subagent integration validation
```

---

## Documentation Index

- [`docs/BROAD_MOBILITY_SURFACE.md`](./docs/BROAD_MOBILITY_SURFACE.md) — Architectural principles and batching design.
- [`docs/TOOLS.md`](./docs/TOOLS.md) — Complete 10-tool input/output contract specifications.
- [`docs/CONFIG.md`](./docs/CONFIG.md) — Configuration schemas and environment variables.
- [`docs/TAILSCALE.md`](./docs/TAILSCALE.md) — Authoritative guide for Tailscale Serve and Funnel.
- [`docs/TUNNEL_CLIENT.md`](./docs/TUNNEL_CLIENT.md) — OpenAI Secure MCP Tunnel setup guide.
- [`docs/MULTI_MACHINE.md`](./docs/MULTI_MACHINE.md) — Multi-node deployment architectures.
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) — Diagnostics and error resolution.
- [`SECURITY.md`](./SECURITY.md) — Threat model, sandbox boundaries, and vulnerability reporting.
