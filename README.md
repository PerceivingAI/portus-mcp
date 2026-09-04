# Portus MCP

Portus MCP is an MCP server for AI-assisted project work across local machines, remote machines, and VMs. **The connection is the product; tools are policy-bounded adapters.** A client connects to a registered project through one server and uses a small broad surface for ordinary project mobility.

## Exposed Tool Surface

Portus MCP exposes one fixed ten-tool surface:

```text
project_context
project_read
project_search
project_edit
project_patch
project_run
project_policy
project_screenshot
subagent_task
subagent_context
```

Together they provide alias-only project discovery, bounded project context, ordered reads, search, file and directory edits, patch preparation/application, approved execution, session-owned GUI screenshots, policy inspection/administration, and Flue subagent lifecycle management and context retrieval.

## Requirements

You need Node.js 20.9 or newer, npm, and Git.

For access from another machine or hosted client, use Tailscale Funnel, Cloudflare Tunnel, or another exposure layer that can reach the MCP server.

Provider credentials are needed only when spawning agents. The seven broad project tools and connected-agent skill reads do not require provider credentials.

## Install

```text
npm install
```

CI uses Node.js 20 with npm 10. Use npm 10 semantics when updating dependencies or regenerating `package-lock.json` so it stays compatible with `npm ci` in GitHub Actions.

Copy `.env.example` to `.env`. At minimum, register a project:

On Windows:
```env
PORTUS_MCP_PROJECTS=app=C:/path/to/project
```

On Linux:
```env
PORTUS_MCP_PROJECTS=app=/home/user/projects/app
```

List multiple projects on separate lines inside single quotes (or separate with newlines/pipes/semicolons):

On Windows:
```env
PORTUS_MCP_PROJECTS='
  app=C:\path\to\app
  api=C:\path\to\api
'
```

On Linux:
```env
PORTUS_MCP_PROJECTS='
  app=/home/user/projects/app
  api=/home/user/projects/api
'
```
### Allow device commands

Portus ships with `portus-mcp.policy.json` as its default complete operator policy. If `PORTUS_MCP_POLICY_PATH` is unset, that shipped file is selected. To maintain a private policy, copy the complete shipped file to the Git-ignored `portus-mcp.policy.local.json`, edit it, and select it in `.env`:

```env
PORTUS_MCP_POLICY_PATH=./portus-mcp.policy.local.json
```

The selected file is a strict replacement, not an overlay: shipped and private policies are never merged. A missing file, invalid JSON, unknown key, or invalid value fails startup. Policies created before the `subagentContext` permission was introduced must add that required Boolean explicitly; there is no fallback to `subagentTask`. Runtime files under `.portus-mcp/` cannot override permissions, and no MCP tool can mutate them.

Portus ships with only `git` in `main_agent.permissions.allowedCommands`. Add executable basenames to that field in the selected complete policy, not arguments or shell command strings; omit Windows `.exe`, `.cmd`, and `.bat` suffixes. Grant only commands you intend the connected main agent to control: allowlisting Bash, PowerShell, Python, Node.js, or another interpreter gives it the broad authority that executable has under the Portus OS account. Direct main-agent commands use `main_agent.permissions.allowedCommands`; spawned subagents use the separate `subagents.permissions.allowedCommands`. Restart Portus after changing `.env` or the selected policy.

The shipped `portus-mcp.config.json` configures default subagent retry behavior and traversal exclusions:

```json
{
  "subagents": {
    "defaultTemplate": "ephemeral-project-subagent"
  },
  "traversal": {
    "excludedPatterns": [".git", "node_modules", "dist", ".portus-mcp", ".portus-artifacts"]
  }
}
```

Keep the required application-config fields from the shipped file. Only add provider credentials when spawning subagents.
## Skills

Portus treats skills as configured, read-only filesystem packages—not as skill-specific MCP tools. Two environment variables select independent audiences:

```text
AGENT_SKILL_PATHS=./skills
SUBAGENTS_SKILL_PATHS=./skills
```

- `AGENT_SKILL_PATHS` populates the catalog available to the connected MCP client through `project_context` with `include.skills=true`.
- `SUBAGENTS_SKILL_PATHS` populates the catalog and read-only `/skills/<name>` mounts given to Portus-spawned agents.
- Each value accepts semicolon-separated individual skill directories or catalog directories.
- Relative paths resolve from the directory containing `portus-mcp.config.json`.
- An unset variable uses the local `./skills` catalog when it exists. An explicitly empty value disables that audience.
- No user, system, Codex, or other host skill directory is scanned implicitly.
- The current set of skills on the `./skills` folder are examples which should be replaced with your own skills.

Skills are startup snapshots. After adding, deleting, changing, or reconfiguring a skill, restart Portus; reconnect the MCP client or start a new spawned-agent session. There are no `skill_list`, `skill_read`, `skill_run`, or `agent_run_skill` tools.

## Start

```text
npm start
```

Local MCP endpoint:

```text
http://127.0.0.1:8789/mcp
```

Health endpoint:

```text
http://127.0.0.1:8789/
```

## Connect with `tunnel-client`

Portus MCP connects to agents via the `tunnel-client` daemon.

### Setup Wizard

Run the interactive setup wizard to install and configure `tunnel-client`:

```bash
npm run setup:tunnel
```

Or run the platform script:
- **Windows (PowerShell)**: `.\scripts\setup-tunnel.ps1`
- **Linux / macOS (Bash)**: `./scripts/setup-tunnel.sh`

### Daily Startup

#### Single-Command Launcher (Recommended)

Run both Portus MCP and `tunnel-client` together in one terminal:

```bash
npm run start:tunnel
```
*(Press `Ctrl+C` once to stop both processes cleanly).*

#### Two-Terminal Setup (Alternative)

```powershell
# Terminal 1
npm start

# Terminal 2
tunnel-client run --profile portus-local
```
### Connect in ChatGPT

1. In ChatGPT, navigate to **Settings** -> **Plugins (or Connectors)** -> **Browse plugins**.
2. Click **+** (add plugin), select **Tunnel**, and choose your configured tunnel.
3. Select **No Auth**, accept the disclaimer, and click **Create** -> **Connect**.

*(Optional)* In plugin settings, configure confirmation behavior under "Choose when ChatGPT should ask for permission".

---

## Use From Another Client & Tailscale Setup

For complete, detailed instructions on using Tailscale (Tailscale Serve for private inter-device mesh access and Tailscale Funnel for public cloud connectors like Perplexity), see the authoritative guide:

```text
docs/TAILSCALE.md
```
### Single-Command Launchers

Launch Portus MCP and Tailscale together in one terminal:

* **Public Cloud Connectors (Perplexity)**:
  ```bash
  npm run start:funnel
  ```
* **Private Inter-Device Mesh (Personal Devices)**:
  ```bash
  npm run start:serve
  ```
*(Press `Ctrl+C` once to stop both processes cleanly).*

To check your active Tailscale status and inspect your complete target MCP URL:

```bash
npm run tailscale:status
```

On systems where Tailscale requires elevation:

```text
sudo tailscale funnel 8789
```

Tailscale prints a root URL such as:

```text
https://machine.tailnet.ts.net/
```

Add the MCP path and configure the client for Streamable HTTP:

```text
https://machine.tailnet.ts.net/mcp
```

## Multi-Machine Use

Run Portus MCP on each machine you want to access. One MCP entry per machine keeps project roots and policies independently selectable:

```text
Portus_LinuxVM
Portus_WinRemote
Portus_Workstation
```

The same conversation can use multiple connections while each server retains its own registered roots, permissions, limits, and availability boundary.

## Security

Broad tools remain bounded by layered enforcement:

- connector, tunnel, MCP server, and process availability;
- registered project-root confinement;
- blocked-path, traversal, and Git-ignore policy;
- capability permissions and approved command policy;
- server-owned request, input, output, scan, patch, edit, timeout, and process limits;
- explicit confirmation for destructive or protected operations;
- durable, redacted audit for mutation and execution;
- operating-system permissions; and
- strict schemas and safe, project-relative errors.

Callers cannot raise server maxima or override path, permission, confirmation, or audit policy. Search excludes ignored paths by default; explicit ignored-path inclusion is confined to one request and requires selected-policy authorization. Read, context, search, policy inspection, and patch preparation remain unaudited; mutation and execution retain audit behavior. Errors and safe policy projections do not expose absolute roots, selected policy paths, secrets, command environments, or file contents.

Spawned subagents are command-capable processes bounded by Flue workspace isolation in `.portus-mcp/flue-workspaces/<sessionId>`. `main_agent.permissions.subagentTask` independently controls lifecycle actions; `main_agent.permissions.subagentContext` controls session listings, status, outputs, events, and capability inspection.

## Project Cold Start

A client that does not yet know a project alias calls `project_context` with `include.projects=true` and no `projectAlias`. The result contains registered aliases only. It then selects an alias and calls scoped `project_context`; the default response includes `capabilities`, status, tree, and scripts. `capabilities.availableTools` is the complete effective allowlist for planning: every entry is enabled, and a registered MCP tool absent from the allowlist must not be invoked. `project_run.allowedCommands` appears only when `project_run` is available. Any project-scoped context section still requires `projectAlias`.

Audit inspection and policy checks are native `project_policy` operations rather than separate management tools. Project registration is configured exclusively through the environment (`PORTUS_MCP_PROJECTS`). Its safe policy checks are read-only; no MCP action can change permissions. See `docs/TOOLS.md` for the exact boundaries.

## Tool Operations

Use `project_read.requests[]` for reads and complete-file hashes, `project_context.include` for status, the positive capability allowlist, and metadata, `project_search.requests[]` for batched searches (1-20 requests), `project_patch.mode` for patches, `project_run.requests[]` for batched process execution (1-10 requests), and `project_policy` for policy checks or native administrative actions. `project_edit.operations[]` defaults to staged write/text-edit execution with projected same-path state, base-hash guards, and pre-commit revalidation; select `batchMode: "ordered"` for filesystem operations or intentional immediate sequencing. Edit results distinguish applied, no-change, planned, rejected, failed, and skipped operations.

See `docs/TOOLS.md` for the current tool contract and `docs/BROAD_MOBILITY_SURFACE.md` for the architectural decision.

## Session-owned screenshots

`project_screenshot` can list configured GUI applications installed on the host (`app_discovery`), capture visible application windows owned by a running `project_run` execution session (`capture_running`), or launch a command directly and capture its window (`capture_launch`). Configured apps are resolved to their installed executable path inside `capture_launch`; the agent supplies only the configured command name and optional launch arguments. Enable `main_agent.permissions.projectScreenshot` in the selected policy. (`src/tools/projectScreenshot.ts`, `src/runtime/appDiscovery.ts`, `src/runtime/screenshotSystem.ts`)

```json
{
  "operation": "capture_running",
  "projectAlias": "app",
  "executionSessionId": "exec_1787430000000_a1b2c3d4",
  "closeSession": true,
  "format": "png"
}
```

Operations are `app_discovery`, `discover_running`, `capture_launch`, `capture_running`, `read`, `list`, and `delete`. `screenshot.appDiscovery.commands` contains names resolved through normal discovery; `screenshot.appDiscovery.aliases` maps agent-facing names to absolute executable paths. `app_discovery` returns one flat, deduplicated list of usable names without launching apps or exposing paths, and aliases win name collisions. A matching `capture_launch.command` is authorized by that operator-controlled shortcut configuration and launched directly without consulting `main_agent.permissions.allowedCommands`; commands absent from it retain the existing allowlist-controlled launch behavior. Capture operations require `closeSession: boolean` to explicitly declare whether the execution session process tree should be terminated immediately following successful capture (`closeSession=true`) or remain open (`closeSession=false`). Captures and read return native MCP image content unless `returnImage=false`. Files are stored under `.portus-artifacts/screenshots/<executionSessionId>/` in the selected registered project and remain there until an explicit `delete` request.

Windows, macOS, and Linux X11 use the npm-installed native worker. Wayland returns `unsupported_session_window_capture`.


## Platforms

Portus runs on Windows, macOS, and Linux. Session-window screenshots use the native npm worker on Windows, macOS, and Linux X11; Wayland capture fails closed when ownership cannot be attested.

## Validation

```text
npm run check
npm test
npm run build
npm run flue:check
```

The broad-surface acceptance suite must also prove exact seven-tool default discovery, profile isolation, absence of retired names, strict schemas, normal workflows, permission and confirmation boundaries, Git-ignore and root policy, server limits, audit behavior, and safe errors without absolute-path or secret leakage.

## More Documentation

```text
docs/BROAD_MOBILITY_SURFACE.md
docs/CLIENTS.md
docs/CONFIG.md
docs/MULTI_MACHINE.md
docs/TUNNEL_CLIENT.md
docs/TOOLS.md
docs/TROUBLESHOOTING.md
docs/VALIDATION.md
SECURITY.md
```

Start with `docs/BROAD_MOBILITY_SURFACE.md`, `docs/TOOLS.md`, `docs/CLIENTS.md`, `docs/MULTI_MACHINE.md`, and `docs/TUNNEL_CLIENT.md` for OpenAI Secure MCP Tunnel client setup.

Flue provides spawned-agent support. Direct broad MCP project tools work without spawned agents.

Flue: https://github.com/withastro/flue
