#!/usr/bin/env bash
# Mission Control one-shot setup.
# Goals: work on macOS and Linux, survive nvm/fnm/volta/homebrew node setups,
# recover from common failures by itself, and speak plainly to non-technical
# users. Safe to re-run at any time.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3333}"
HOST="${HOST:-127.0.0.1}"
SERVICE_NAME="openclaw-dashboard"
OS="$(uname -s)"

NO_SERVICE=0
DEV_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-service) NO_SERVICE=1; shift ;;
    --dev) DEV_MODE=1; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<EOF
Mission Control setup

Usage:
  ./setup.sh [--port 3333] [--host 127.0.0.1] [--dev] [--no-service]

Defaults:
  PORT=${PORT}
  HOST=${HOST}

Behavior:
  1) Finds a suitable Node.js (PATH, nvm, fnm, volta, homebrew, system)
  2) Installs dependencies (with automatic retry on failure)
  3) Builds the dashboard (unless --dev)
  4) Picks a free port automatically if yours is taken
  5) Starts it as a background service (unless --no-service)
  6) Verifies the dashboard actually responds before declaring success

Service support:
  - macOS: launchd user agent
  - Linux: systemd --user service (with lingering for headless servers)
  - Anything else: nohup fallback

VPC / hosted deployments:
  Put deployment settings (MISSION_CONTROL_AUTH, tokens, HOST=0.0.0.0 behind
  a reverse proxy, etc.) in a .env file next to this script — the background
  service loads it automatically. See docs/DEPLOYMENT.md.
EOF
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

log()  { printf "\033[1;36m[setup]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ ok ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*" >&2; }
fail() {
  printf "\n\033[1;31m[setup failed]\033[0m %s\n" "$*" >&2
  printf "Nothing on your system was broken. You can safely re-run ./setup.sh after fixing the above.\n" >&2
  exit 1
}

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  warn "You are running as root/sudo. This usually causes permission problems — a normal user shell is better."
fi

# ── 1. Find a usable Node.js ─────────────────────────────────────────────────
# Non-technical users often have node installed by a tool (nvm, homebrew) that
# is not visible to scripts or services. Hunt for the best one instead of
# failing with a cryptic error.

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

find_best_node() {
  local candidates=() dir v best="" best_major=0
  # Anything already on PATH goes first.
  if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
  # nvm installs
  for dir in "$HOME"/.nvm/versions/node/*/bin/node; do
    [[ -x "$dir" ]] && candidates+=("$dir")
  done
  # fnm, volta, homebrew, system
  for dir in "$HOME"/.local/state/fnm_multishells/*/bin/node \
             "$HOME"/.fnm/node-versions/*/installation/bin/node \
             "$HOME"/.volta/bin/node \
             /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -x "$dir" ]] && candidates+=("$dir")
  done
  for v in ${candidates[@]+"${candidates[@]}"}; do
    local m; m="$(node_major "$v")"
    if [[ "$m" -ge 20 && "$m" -gt "$best_major" ]]; then
      best="$v"; best_major="$m"
    fi
  done
  echo "$best"
}

log "Looking for Node.js 20 or newer..."
NODE_PATH_FOUND="$(find_best_node)"
if [[ -z "$NODE_PATH_FOUND" ]]; then
  if command -v node >/dev/null 2>&1; then
    fail "Your Node.js is too old ($(node --version)). Mission Control needs Node 20+.
  Easiest fix:
    macOS:  brew install node
    Linux:  https://nodejs.org/en/download (or: curl -fsSL https://fnm.vercel.app/install | bash)"
  else
    fail "Node.js was not found on this computer. Mission Control needs Node 20+.
  Easiest fix:
    macOS:  install Homebrew (https://brew.sh) then run: brew install node
    Linux:  https://nodejs.org/en/download (or: curl -fsSL https://fnm.vercel.app/install | bash)
  Then run ./setup.sh again."
  fi
fi
NODE_BIN_DIR="$(dirname "$NODE_PATH_FOUND")"
export PATH="$NODE_BIN_DIR:$PATH"
ok "Using Node $("$NODE_PATH_FOUND" --version) at $NODE_PATH_FOUND"

command -v npm >/dev/null 2>&1 || fail "npm was not found next to node ($NODE_BIN_DIR). Reinstall Node.js — npm comes with it."

if ! command -v openclaw >/dev/null 2>&1; then
  warn "The 'openclaw' command was not found. Mission Control will still start, but you need OpenClaw for it to show anything."
  warn "Install it from https://docs.openclaw.ai/install"
fi

[[ "$PORT" =~ ^[0-9]+$ ]] || fail "Invalid port: ${PORT}"

cd "$ROOT_DIR"

# ── 2. Install dependencies (with retries) ───────────────────────────────────

check_lightningcss() { node -e 'require("lightningcss")' >/dev/null 2>&1; }

npm_install_once() {
  if [[ -f package-lock.json ]]; then
    npm ci --include=optional --no-audit --no-fund
  else
    npm install --include=optional --no-audit --no-fund
  fi
}

log "Installing dependencies (this can take a few minutes the first time)..."
if ! npm_install_once; then
  warn "First install attempt failed. Cleaning up and retrying — this fixes most transient problems..."
  rm -rf node_modules
  npm cache verify >/dev/null 2>&1 || true
  if ! npm_install_once; then
    warn "Retrying once more with a plain install..."
    npm install --include=optional --no-audit --no-fund || fail "Dependency installation failed three times.
  Common causes: no internet connection, or a proxy blocking npm.
  Check your connection and re-run ./setup.sh"
  fi
fi
ok "Dependencies installed."

if ! check_lightningcss; then
  warn "A native package (lightningcss) is missing. Fetching it directly..."
  npm install --include=optional --no-audit --no-fund --no-save lightningcss || true
fi
check_lightningcss || fail "The lightningcss native package could not be installed (required by the build).
  Try: rm -rf node_modules package-lock.json && ./setup.sh (without sudo)"

# ── 3. Build ─────────────────────────────────────────────────────────────────

if [[ "$DEV_MODE" -eq 0 ]]; then
  log "Building the dashboard..."
  if ! npm run build; then
    warn "Build failed. Clearing the build cache and retrying once..."
    rm -rf .next
    npm run build || fail "The production build failed twice. The error above has the details.
  You can still try development mode: ./setup.sh --dev"
  fi
  ok "Build complete."
fi

# ── 4. Pick a free port ──────────────────────────────────────────────────────

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&-; return 0; } || return 1
  fi
}

ORIGINAL_PORT="$PORT"
tries=0
while port_in_use "$PORT"; do
  tries=$((tries + 1))
  [[ $tries -gt 20 ]] && fail "Could not find a free port near ${ORIGINAL_PORT}."
  PORT=$((PORT + 1))
done
if [[ "$PORT" != "$ORIGINAL_PORT" ]]; then
  warn "Port ${ORIGINAL_PORT} is already in use — using port ${PORT} instead."
fi

# ── 5. Start ─────────────────────────────────────────────────────────────────

# The service shell does not load nvm/fnm init files, so pin the node dir we
# resolved above, and load an optional .env so deployment settings
# (MISSION_CONTROL_AUTH*, VPC config) reach the service. See docs/DEPLOYMENT.md.
ENV_PRELUDE="export PATH=\"$NODE_BIN_DIR:\$PATH\"; set -a; [ -f \"$ROOT_DIR/.env\" ] && . \"$ROOT_DIR/.env\"; set +a"

start_foreground() {
  if [[ "$DEV_MODE" -eq 1 ]]; then
    log "Starting in development mode (foreground)..."
    exec npm run dev -- -H "$HOST" -p "$PORT"
  else
    log "Starting in production mode (foreground)..."
    exec npm run start -- -H "$HOST" -p "$PORT"
  fi
}

install_launchd_service() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_path="${plist_dir}/com.openclaw.dashboard.plist"
  mkdir -p "$plist_dir"

  local run_cmd
  if [[ "$DEV_MODE" -eq 1 ]]; then
    run_cmd="${ENV_PRELUDE}; cd \"$ROOT_DIR\" && PORT=\"$PORT\" HOST=\"$HOST\" npm run dev -- -H \"$HOST\" -p \"$PORT\""
  else
    run_cmd="${ENV_PRELUDE}; cd \"$ROOT_DIR\" && PORT=\"$PORT\" HOST=\"$HOST\" npm run start -- -H \"$HOST\" -p \"$PORT\""
  fi

  cat >"$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>${run_cmd}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${ROOT_DIR}/.dashboard.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT_DIR}/.dashboard.err.log</string>
</dict>
</plist>
EOF

  launchctl unload "$plist_path" >/dev/null 2>&1 || true
  launchctl load -w "$plist_path" || fail "macOS refused to register the background service (launchctl). The error above has details."
  ok "Registered background service (launchd). It starts automatically at login."
}

install_systemd_user_service() {
  local service_dir="$HOME/.config/systemd/user"
  local service_path="${service_dir}/${SERVICE_NAME}.service"
  mkdir -p "$service_dir"

  local exec_line
  if [[ "$DEV_MODE" -eq 1 ]]; then
    exec_line="/usr/bin/env bash -c '${ENV_PRELUDE}; cd \"$ROOT_DIR\" && PORT=\"$PORT\" HOST=\"$HOST\" npm run dev -- -H \"$HOST\" -p \"$PORT\"'"
  else
    exec_line="/usr/bin/env bash -c '${ENV_PRELUDE}; cd \"$ROOT_DIR\" && PORT=\"$PORT\" HOST=\"$HOST\" npm run start -- -H \"$HOST\" -p \"$PORT\"'"
  fi

  cat >"$service_path" <<EOF
[Unit]
Description=OpenClaw Mission Control Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
ExecStart=${exec_line}
Restart=always
RestartSec=2
Environment=PORT=${PORT}
Environment=HOST=${HOST}

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.service" || fail "systemd refused to start the service. Check: systemctl --user status ${SERVICE_NAME}"
  ok "Registered background service (systemd --user)."

  # On headless servers (VPC/hosted), user services stop when the login session
  # ends unless lingering is enabled. Enable it so the dashboard survives logout.
  if command -v loginctl >/dev/null 2>&1; then
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
      if loginctl enable-linger "$USER" >/dev/null 2>&1; then
        ok "Enabled lingering — the dashboard keeps running after you log out."
      else
        warn "Could not enable lingering automatically. On a server, run once: sudo loginctl enable-linger $USER"
        warn "Without it, the dashboard stops when your SSH session ends."
      fi
    fi
  fi
}

start_with_nohup() {
  log "No service manager found — starting with nohup instead..."
  mkdir -p "${ROOT_DIR}/.run"
  local log_path="${ROOT_DIR}/.run/dashboard.out.log"
  if [[ "$DEV_MODE" -eq 1 ]]; then
    bash -c "${ENV_PRELUDE}; cd \"$ROOT_DIR\" && nohup npm run dev -- -H \"$HOST\" -p \"$PORT\" >\"$log_path\" 2>&1 & echo \$! > \"${ROOT_DIR}/.run/dashboard.pid\""
  else
    bash -c "${ENV_PRELUDE}; cd \"$ROOT_DIR\" && nohup npm run start -- -H \"$HOST\" -p \"$PORT\" >\"$log_path\" 2>&1 & echo \$! > \"${ROOT_DIR}/.run/dashboard.pid\""
  fi
  warn "Note: without a service manager the dashboard will not restart after a reboot. Re-run ./setup.sh after rebooting."
}

if [[ "$NO_SERVICE" -eq 1 ]]; then
  start_foreground
fi

log "Configuring the background service..."
if [[ "$OS" == "Darwin" ]]; then
  install_launchd_service
elif [[ "$OS" == "Linux" ]] && command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  install_systemd_user_service
else
  start_with_nohup
fi

# ── 6. Verify it actually works ──────────────────────────────────────────────

log "Waiting for the dashboard to come up..."
attempt=0
until curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${PORT}/" 2>/dev/null | grep -qE "^(200|30.)$"; do
  attempt=$((attempt + 1))
  if [[ $attempt -gt 30 ]]; then
    warn "The dashboard did not respond within 90 seconds."
    warn "Recent service log:"
    tail -n 20 "${ROOT_DIR}/.dashboard.err.log" 2>/dev/null || tail -n 20 "${ROOT_DIR}/.run/dashboard.out.log" 2>/dev/null || true
    fail "Startup verification failed. The log above usually explains it. Re-run ./setup.sh after fixing."
  fi
  sleep 3
done

echo
ok "Mission Control is up and verified."
echo
echo "  ➜  Open:  http://${HOST}:${PORT}"
echo
echo "Remote tunnel example:"
echo "  ssh -N -L ${PORT}:127.0.0.1:${PORT} user@your-server"
echo
echo "VPC / hosted setup (auth, reverse proxy): see docs/DEPLOYMENT.md"
echo
