![Mission Control — AI Agent Harness & Dashboard](cover.png)

# Mission Control

**English** | [中文](README.zh-CN.md) | [日本語](README.ja.md)

**A harness for running a fleet of AI agents from one screen. See everything, dispatch anything, all on your own machine.**

I run a lot of agents at once. One writing code, one on research, one watching an inbox, a few more on whatever I pointed them at that morning. Past two or three, terminals stop working as an interface. So I built my own harness for it. This is it.

Mission Control is the control plane over the fleet. Watch agents work live, hand them tasks and let them pick them up, spin up subagents and fan them out, see what everything costs, keep the whole thing healthy. It runs locally and drives [OpenClaw](https://github.com/openclaw) as the engine underneath.

## ⚡ Hand it to your agent to install

You don't install things by hand anymore. Point Claude Code, Codex, or whatever you drive at this and it does the rest:

```text
Install Mission Control, the dashboard for OpenClaw, on this machine.

1. Check prerequisites: `node --version` must be >= 20, and `openclaw --version`
   must work. If OpenClaw is missing, install it first per
   https://docs.openclaw.ai/install and complete its onboarding.
2. Install:
     cd ~/.openclaw
     git clone https://github.com/robsannaa/openclaw-mission-control.git
     cd openclaw-mission-control
     ./setup.sh
   (setup.sh is safe to re-run if anything fails.)
3. If port 3333 is already taken, re-run as: PORT=3344 ./setup.sh
4. Verify it works: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3333`
   must print 200 (use the port you chose).
5. Do not finish until that check passes, then tell me the exact URL to open
   and how the background service was registered (launchd/systemd/nohup).
```

A lot of this was written by the agents it runs. That is the point of it.

## Please, consider supporting me and buy me a Claude Code Subscription!
[![Buy Me a Claude Code Subscription!](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-orange?logo=buy-me-a-coffee)](https://www.buymeacoffee.com/robsanna)

[![AI Agent Harness](https://img.shields.io/badge/AI_Agent-Harness-7c3aed?style=flat-square)](https://github.com/robsannaa/openclaw-mission-control) ![Self-Hosted](https://img.shields.io/badge/Self--Hosted-Local_AI-f59e0b?style=flat-square) ![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

---

## Why it exists

Past a couple of agents, the bottleneck stops being the model and becomes you. You tab between terminals, lose track of what is running, and guess at what it cost. A harness fixes that. You point an agent at a problem, drop it on the board, and go start the next one while it runs.

The harness should never be the interesting part. The agents are the work. Mission Control is built to sit behind them and stay out of the way: nothing to babysit, nothing to sync, hard to break. You should be able to forget it is there and keep shipping.

---

## Thin by design

Mission Control does not store your data, run a database, or try to be the source of truth. It reads and writes straight through to the engine underneath, live. Change something here and it lands immediately, with no sync step and no cache to go stale. The only state it keeps is two small local files: usage history and the task board.

That keeps it:

- **Accurate.** What you see is what is running, right now.
- **Boring to maintain.** No migrations, no backups, no cleanup jobs. On purpose.
- **Hard to break.** If the dashboard goes down, the agents keep running.
- **Instant.** Nothing to provision, nothing to upgrade between versions.

Pull the dashboard out and the fleet still runs. It is glass over the engine, not the engine.

---

## What it does

### See the whole fleet
**Dashboard** opens on a live overview: which agents are active, gateway health, running cron jobs, and system load (CPU, memory, disk). No clicking around to find out if things are working.

### Talk to any of them
**Chat** is a real conversation with any agent, in the browser. Attach files, pick the model, stream the response, switch agents without losing context. `/` for commands, `@` to pull in a file.

### Point agents at work and watch it move
**Tasks** is a board (Backlog, In Progress, Review, Done) where a card is not a note. It is a job an agent runs. Drop one in, an agent picks it up, and you watch it cross to Done. This is where "point a few agents at the problem and go" becomes something you can see.

### Keep agents working while you don't
**Cron Jobs** run agents on a schedule: summarize the inbox every morning, check for updates every hour. Create, edit, pause, and test, with full run history so you know what happened overnight.

### Command the team
**Agents** shows the whole hierarchy as a live org chart: every agent and subagent, who is active, which channels they are on, which workspace. Spin up new subagents and fan them out on the spot.

### Know the cost to the token
**Usage** tracks every token across every model and agent. Cost breakdowns, which agent is burning budget, where the money goes. Charts, not spreadsheets.

### Keep their memory sharp
**Memory** views and edits long-term memory and daily journals. **Vector Search** finds anything in semantic memory instantly.

### Own the models and keys
**Models** is one place to see every available model, set provider credentials, configure fallback chains, and switch models per agent. No hand-editing config files.

### Keep the fleet healthy
**Doctor** runs diagnostics and shows what is healthy and what needs attention, with one-click fixes for common issues. **Gateway** status stays visible so you always know it is connected.

### Drop into a shell
**Terminal** is a full command line in the dashboard: multiple tabs, color support, no window-switching.

### Reach agents where you already are
**Channels** connects your agents to Telegram, Discord, WhatsApp, Signal, and Slack, with QR pairing where supported.

### Browse everything they touch
**Documents** explores workspace files across agents. **Search** (`Cmd+K`) is instant semantic search across all of it.

### Stay in control
**Security** audits your setup and flags issues. **Permissions** controls what agents may execute. **Accounts & Keys** manages every credential in one place with proper masking.

### Run it from anywhere
**Tailscale** integration reaches the dashboard and your agents securely from any machine, with tunnel controls built in.

### One panel failing never takes the rest down
Every section is wrapped in an **error boundary**. One view breaking leaves the others running. Hit Retry and you are back, no full reload.

---

## Quick Start

### 1. Make sure the engine is installed

```bash
# Install OpenClaw if you haven't already
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify it's running
openclaw --version
```

### 2. Install Mission Control

```bash
cd ~/.openclaw
git clone https://github.com/robsannaa/openclaw-mission-control.git
cd openclaw-mission-control
./setup.sh
```

That's it. Open `http://localhost:3333`.

**Other ways to start:**

```bash
# Change the port
PORT=8080 ./setup.sh

# Development mode (no background service)
./setup.sh --dev --no-service

# Manual mode
npm install && npm run dev
```

> **Zero configuration.** It finds your `~/.openclaw` directory and the `openclaw` binary on its own. Nothing to set up.

### Or just ask your agent

Already talking to an agent? Hand it off:

```
Hey, install Mission Control for me — here's the repo:
https://github.com/robsannaa/openclaw-mission-control
```

It clones the repo, installs dependencies, and starts it up.

---

## Remote Access

Running on a server? Reach it from your laptop with an SSH tunnel:

```bash
ssh -N -L 3333:127.0.0.1:3333 user@your-server
```

Then open `http://localhost:3333` locally.

---

## Environment Variables (optional)

Everything is auto-detected. Override if you need to:

| Variable | Default | What it does |
|---|---|---|
| `OPENCLAW_HOME` | `~/.openclaw` | Where your agent data lives |
| `OPENCLAW_BIN` | Auto-detected | Path to the `openclaw` command |
| `OPENCLAW_WORKSPACE` | Auto-detected | Your default workspace folder |
| `OPENCLAW_TRANSPORT` | `auto` | How to reach the gateway: `auto`, `http`, or `cli` |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway address (for remote setups) |
| `OPENCLAW_GATEWAY_TOKEN` | _(empty)_ | Bearer token for authenticated gateway HTTP access |
| `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS` | _(unset)_ | Set to `1` to allow the CLI to connect to private/self-signed WebSocket endpoints (e.g. a local gateway over `ws://`). Mission Control sets this when invoking the CLI; override only if you need different behavior. |

---

## FAQ

<details>
<summary><strong>"OpenClaw not found" — what do I do?</strong></summary>

Make sure the `openclaw` command works in your terminal:

```bash
openclaw --version
```

If that works but the dashboard still complains, point it directly:

```bash
OPENCLAW_BIN=$(which openclaw) npm run dev
```

If it isn't installed, [get it here](https://docs.openclaw.ai/install).
</details>

<details>
<summary><strong>Does this send my data anywhere?</strong></summary>

No. Mission Control sends nothing out: no analytics, no tracking, no phoning home. The only network calls are the ones you configure: your gateway, and whichever model providers you set up (your choice, including fully local models).
</details>

<details>
<summary><strong>Can I run more than one setup?</strong></summary>

Yes. Point it at a different installation:

```bash
OPENCLAW_HOME=/path/to/other/.openclaw npm run dev -- --port 3001
```
</details>

<details>
<summary><strong>Port already in use?</strong></summary>

Pick a different one:

```bash
npm run dev -- --port 8080
```
</details>

---

## Contributing

Pull requests welcome. Found a bug or have an idea? [Open an issue](https://github.com/robsannaa/openclaw-mission-control/issues).

Before opening a pull request, run `npm run test:premerge` against your local dev
instance. See [`docs/TESTING.md`](docs/TESTING.md) for what each test lane needs
and which lanes must be green before a merge.

---

## License

MIT
