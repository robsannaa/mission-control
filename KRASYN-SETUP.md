# Mission Control — Krasyn / Ben's Mac quickstart

Ben-specific setup notes layered on top of the upstream `README.md`. Everything here is machine-specific to this install; keep it out of any upstream PR.

## Pre-flight check (already true on this Mac)

- OpenClaw is installed at `~/.openclaw` (29 MB, 3 agents: `main`/`claude-cli`/`claude-code`).
- Gateway is running on `127.0.0.1:18789` (token auth, loopback bind).
- Gateway token lives in `~/.openclaw/openclaw.json` under `gateway.auth.token`. Mission Control auto-reads it — you should not have to paste it anywhere.
- Primary model `openai/gpt-5.4` (orchestrator). Sub-agents: `qwen` (ollama/qwen3:14b), `gemma` (ollama/gemma4, still downloading). Fallbacks on GPT-5.4 failure: gpt-5.4-mini → qwen3:14b. Ollama at `127.0.0.1:11434`.
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
2. **Agents** — org chart renders. Em (`main`, GPT-5.4) is marked "Orchestrator". `qwen` and `gemma` appear as "Sub-agent" nodes with animated "invokes" edges from Em. Click a node → agent details.
3. **Tasks** — empty Kanban (Backlog / In Progress / Review / Done). Try creating a card; it should land as a file in `~/.openclaw/workspace`.
4. **Memory** — `MEMORY.md` (Ben's long-term memory) loads. Daily notes directory is at `~/.openclaw/workspace/memory/` (created on first write).
5. **Channels** — Telegram shows "connected" for agent `main`. No re-pairing needed.
6. **Cron** — empty list. Heartbeat is running inside the gateway process.
7. **Doctor** — run it once. Expect all green except possibly Tailscale (off by default in `openclaw.json`).

## Agent architecture (orchestrator + sub-agents)

```
User (Telegram / Mission Control chat)
  └── Em (main) — openai/gpt-5.4  ← orchestrator, Telegram front-door
        ├── qwen  — ollama/qwen3:14b   ← local heavy lifting (coding, long context)
        └── gemma — ollama/gemma4      ← local fast tasks (gemma4 pulling ~9.6 GB)
```

**How routing works:**
- All user messages go to Em (GPT-5.4). Em is the primary model and the only agent exposed to channels.
- Em invokes sub-agents via the OpenClaw `sessions_spawn` tool. Use `agents_list` to enumerate available targets.
- Fallback (on GPT-5.4 API error only): `openai/gpt-5.4-mini`, then `ollama/qwen3:14b`.
- `qwen`, `gemma`, and `claude-code` are not directly chat-accessible. They appear as sub-agents in the Mission Control hierarchy view.

**Claude Code integration (active):**
`claude` CLI at `/opt/homebrew/bin/claude` (v2.1.114). `claude-code` agent registered in `agents.list` and in `main.subagents.allowAgents`. Em can invoke it via `sessions_spawn(agentId="claude-code", ...)`.

**Critical workspace file — `~/.openclaw/workspace/AGENTS.md`:**
This file is injected at every session startup. It MUST describe Em's role and sub-agents accurately. The `## Session Startup` and `## Red Lines` sections are re-injected after context compaction. If Em claims it can't find sub-agents, check this file first — bad content here will override Em's understanding of its own capabilities.

**Adding more sub-agents:**
```bash
openclaw agents add <name> --model <provider/model> --workspace ~/.openclaw/agents/<name>/workspace --non-interactive
# Allow Em to spawn it:
openclaw config set agents.list[0].subagents.allowAgents '["qwen","gemma","claude-code","<name>"]' --strict-json
# Also update cross-agent session access:
openclaw config set tools.agentToAgent.allow '["qwen","gemma","claude-code","<name>"]' --strict-json
# Then add a description to ~/.openclaw/workspace/AGENTS.md so Em knows when to use it.
```

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
