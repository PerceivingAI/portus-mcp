#!/usr/bin/env bash
set -euo pipefail

PROFILE_NAME="${1:-portus-local}"
INSTALL_DIR="${HOME}/.local/bin"
PORT="${2:-8789}"

# 1. Install tunnel-client if missing
TUNNEL_BIN="tunnel-client"
if command -v tunnel-client >/dev/null 2>&1; then
  TUNNEL_PATH="$(command -v tunnel-client)"
elif [ -f "${INSTALL_DIR}/tunnel-client" ]; then
  TUNNEL_PATH="${INSTALL_DIR}/tunnel-client"
else
  mkdir -p "${INSTALL_DIR}"
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "${ARCH}" in
    x86_64|amd64) TUNNEL_ARCH="amd64" ;;
    aarch64|arm64) TUNNEL_ARCH="arm64" ;;
    *) exit 1 ;;
  esac

  RELEASE_JSON="$(curl -s https://api.github.com/repos/openai/tunnel-client/releases/latest)"
  DOWNLOAD_URL="$(echo "${RELEASE_JSON}" | grep -o "https://[^\"]*${OS}-${TUNNEL_ARCH}\.tar\.gz" | head -n 1)"
  curl -fsSL "${DOWNLOAD_URL}" -o /tmp/tc.tar.gz
  tar -xzf /tmp/tc.tar.gz -C "${INSTALL_DIR}"
  rm -f /tmp/tc.tar.gz
  chmod +x "${INSTALL_DIR}/tunnel-client"
  TUNNEL_PATH="${INSTALL_DIR}/tunnel-client"
  export PATH="${INSTALL_DIR}:${PATH}"
fi

# 2. API Key
CURRENT_KEY="${CONTROL_PLANE_API_KEY:-}"
if [ -n "${CURRENT_KEY}" ]; then
  read -rp "Use existing API Key (${CURRENT_KEY:0:8}...)? (Y/n): " USE_EXISTING
  if [[ "${USE_EXISTING}" == "n" || "${USE_EXISTING}" == "N" ]]; then
    CURRENT_KEY=""
  fi
fi

if [ -z "${CURRENT_KEY}" ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    (xdg-open "https://platform.openai.com/settings/organization/api-keys" >/dev/null 2>&1 &) || true
  fi
  while true; do
    read -rp "Enter OpenAI API Key (sk-...): " KEY
    KEY="$(echo "${KEY}" | tr -d '[:space:]')"
    if [[ "${KEY}" == sk-* ]]; then
      export CONTROL_PLANE_API_KEY="${KEY}"
      if [ -f .env ]; then
        if grep -q "^CONTROL_PLANE_API_KEY=" .env; then
          sed -i "s|^CONTROL_PLANE_API_KEY=.*|CONTROL_PLANE_API_KEY=${KEY}|" .env
        else
          echo -e "\nCONTROL_PLANE_API_KEY=${KEY}" >> .env
        fi
      fi
      if [ -f "${HOME}/.bashrc" ] && ! grep -q "CONTROL_PLANE_API_KEY" "${HOME}/.bashrc"; then
        echo "export CONTROL_PLANE_API_KEY=\"${KEY}\"" >> "${HOME}/.bashrc"
      fi
      break
    fi
    echo "Must start with 'sk-'."
  done
else
  export CONTROL_PLANE_API_KEY="${CURRENT_KEY}"
fi

# 3. Tunnel ID & Notice
echo -e "\nOpenAI UI Notice:
In the OpenAI Platform 'Create tunnel' modal:
- Name and Description are marked with a red asterisk (*) as required.
- Organizations comes pre-selected.
- 'ChatGPT workspaces' does not have an asterisk, but it is MANDATORY.

If you do not select a workspace from the dropdown, the platform will create the tunnel, but the ChatGPT plugin modal will not list or connect to it.\n"

if command -v xdg-open >/dev/null 2>&1; then
  (xdg-open "https://platform.openai.com/settings/organization/tunnels" >/dev/null 2>&1 &) || true
fi

TUNNEL_ID=""
while true; do
  read -rp "Enter Tunnel ID (tunnel_...): " TID
  TID="$(echo "${TID}" | tr -d '[:space:]')"
  if [[ "${TID}" == tunnel_* ]]; then
    TUNNEL_ID="${TID}"
    break
  fi
  echo "Must start with 'tunnel_'."
done

# 4. Generate profile using Portus MCP port (default 8789)
MCP_URL="http://127.0.0.1:${PORT}/mcp"

"${TUNNEL_PATH}" init \
  --profile "${PROFILE_NAME}" \
  --tunnel-id "${TUNNEL_ID}" \
  --mcp-server-url "${MCP_URL}" \
  --health-listen-addr "127.0.0.1:0" \
  --force >/dev/null

echo -e "\nSetup complete. To launch Portus MCP with the tunnel, run:\n  npm run start:tunnel"
