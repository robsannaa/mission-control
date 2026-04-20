# Mission Control — Krasyn / Ben's Mac quickstart

Ben-specific setup notes layered on top of the upstream `README.md`. Everything here is machine-specific to this install; keep it out of any upstream PR.

## Pre-flight check (already true on this Mac)

- OpenClaw is installed at `~/.openclaw` (29 MB, 3 agents: `main`/`claude-cli`/`claude-code`).
- Gateway is running on `127.0.0.1:18789` (token auth, loopback bind).
- Gateway token lives in `~/.openclaw/openclaw.json` under `gateway.auth.token`. Mission Control auto-reads it — you should not have to paste it anywhere.
- Primary model `ollama/qwen3:14b`, fallback `openai/gpt-5.4`. Ollama is expected at `127.0.0.1:11434`.
- Agent `main` (Em) is Telegram-fronting; the bot token is configured.

If `openclaw gateway status` shows `offline`, run `openclaw gateway start` first. Check with:

```bash
openclaw --version
openclaw gateway status
lsof -iTCP:18789 -sTCP:LISTEN
```

## Install

```bash
# Clone (or use the working copy already staged in outputs)
cd ~/Projects 2>/dev/null || (mkdir -p ~/Projects && cd ~/Projects)
git clone https://github.com/robsannaa/openclaw-mission-control.git
cd openclaw-mission-control

# One-shot setup (installs deps + starts dashboard in background)
./setup.sh

# Or, dev mode (foreground, no background service)
./setup.sh --dev --no-service
```

**Port:** this fork defaults to `127.0.0.1:3000` (from `package.json` → `dev` script `next dev -H 127.0.0.1 -p 3000`), not `3333` as the upstream README shows. Override with `PORT=8080 ./setup.sh` if 3000 is taken.

## First-open checks

Open `http://127.0.0.1:3000` and verify:

1. **Dashboard** — gateway indicator green, 3 agents listed (`main`, `claude-cli`, `claude-code`), Ollama reachable.
2. **Agents** — org chart renders. Em (`main`) sits at the top, claude-cli and claude-code appear as siblings. Click a node → agent details + "Start / Stop" controls.
3. **Tasks** — empty Kanban (Backlog / In Progress / Review / Done). Try creating a card; it should land as a file in `~/.openclaw/workspace`.
4. **Memory** — `MEMORY.md` (Ben's long-term memory) loads. Daily notes directory is at `~/.openclaw/workspace/memory/` (created on first write).
5. **Channels** — Telegram shows "connected" for agent `main`. No re-pairing needed.
6. **Cron** — empty list. Heartbeat is running inside the gateway process.
7. **Doctor** — run it once. Expect all green except possibly Tailscale (off by default in `openclaw.json`).

## Expected agent hierarchy (the "org chart")

Given the current `~/.openclaw/agents/` layout:

```
Em (main)            ← orchestrator, Telegram front-door
  ├── claude-cli     ← worker (Claude via CLI)
  └── claude-code    ← worker (Claude Code; owns the Krasyn repo)
```

Add more workers by dropping a new agent folder under `~/.openclaw/agents/<name>/` with its own `openclaw.json`. Mission Control will pick it up on next refresh.

## Known gotchas on this Mac

- `~/.openclaw` has macOS extended-attribute protection (ACLs, the `+` in `ls -la`). Don't try to `git clone` directly into it from a Linux shell — the clone will fail to unlink `.git/config.lock`. Clone into `~/Projects` instead (this doc) and let Mission Control read the OpenClaw state via the gateway.
- Gateway log path is `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (see `~/.openclaw/logs/gateway.log`). Mission Control's Logs view auto-discovers this.
- Em's auto-compaction kicks in when Telegram conversations grow past the qwen3 40k-token window — expect occasional "auto-compaction succeeded; retrying prompt" entries; harmless.
- `controlUi.allowInsecureAuth` is `true` in the current config, meaning the browser sends the bearer token over plain HTTP on localhost. Fine for loopback; don't expose the port beyond 127.0.0.1.

## Remote access (optional)

`openclaw.json` has `tailscale.mode: off`. To reach the dashboard from another machine:

```bash
# Simple SSH tunnel
ssh -N -L 3000:127.0.0.1:3000 krasyn@<this-mac-ip>
```

Or flip Tailscale on in `openclaw.json` (`gateway.tailscale.mode: "on"`) and follow the onboarding.

## Security note

Do **not** commit `~/.openclaw/openclaw.json` or any derivative into this repo or a PR. It contains the gateway bearer token and the Telegram bot token. Mission Control reads these live from disk; they should never be checked in.
