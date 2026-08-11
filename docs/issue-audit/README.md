# Open GitHub Issue Audit — Mission Control `v0.9.0`

Audit date: 2026-08-10  
Repo: `robsannaa/openclaw-mission-control`  
OpenClaw docs consulted: [docs.openclaw.ai](https://docs.openclaw.ai/), [local models](https://docs.openclaw.ai/gateway/local-models), [Ollama](https://docs.openclaw.ai/providers/ollama), [pairing](https://docs.openclaw.ai/channels/pairing), [configuration / config.get](https://docs.openclaw.ai/gateway/configuration)

**Do not close any issues from this audit alone.** Draft replies live in [`drafts/`](./drafts/). Use them after a human reviews tone and any remaining repro.

## Triage summary

| # | Title | Verdict | Disposition |
|---|-------|---------|-------------|
| 70 | Unable to use local only models | **Valid feature gap** | Keep open → implement local-first model path |
| 73 | Skills empty output / always Degraded (no TTY) | **Mostly fixed; residual edge** | Keep open → harden CLI stderr recovery; close after verify |
| 75 | Gateway RPC unavailable for config.get | **Fixed in v0.9.0 / #87** | Close as fixed after ask reporter to upgrade |
| 76 | Can't add vector db | **Same root as #75** | Close as fixed (duplicate) after verify; keep vector UX notes |
| 77 | Unable to scroll on tasks page | **Valid / likely regressed** | Keep open → restore column height binding |
| 78 | Skill detail crash (`bins` undefined) | **Fixed on main** | Close as fixed after ask reporter to upgrade |
| 80 | Gateway offline while online + vector reindex 500 | **Mostly fixed; reindex still fragile** | Split: close gateway half; keep/track reindex |
| 81 | Agent fleet panel not scrollable | **Valid UX gap** | Keep open → mobile-friendly fleet list + pan affordance |
| 82 | save-and-restart 15s CLI timeout | **Fixed on main** | Close as fixed after ask reporter to upgrade |
| 84 | pairing list requires `--channel` | **Fixed on main** | Close as fixed after ask reporter to upgrade |
| 85 | Usage not working | **Same root as #75** | Close as fixed (duplicate) after upgrade + retest |
| 86 | Partnership inquiry (MyClaw.ai) | **Not a product bug** | Close as support/off-topic → private reply |

## Cross-cutting findings (codebase)

Mission Control is a thin local window into OpenClaw (`~/.openclaw`, gateway WS RPC, CLI). Power for users grows when every screen:

1. Prefers **Gateway RPC** (`config.get` / `config.patch` / `skills.status` / `sessions.list` / `channels.status`) over cold CLI.
2. Treats **local providers** (Ollama, LM Studio, vLLM, custom OpenAI-compatible) as first-class, not an afterthought behind API-key wizards.
3. Never conflates **RPC health** with **HTTP `/tools/invoke` exec** (fixed in #87 / `auto-transport.ts`).
4. Survives **headless / no-TTY** service installs (`TERM=dumb`, stderr JSON, missing requirement bags).
5. Keeps layout **scrollable on mobile** when canvases or kanban columns exceed the viewport.

Relevant support range today: OpenClaw `>=2026.7.0 <2026.9.0` (`src/lib/gateway-protocol.ts`). Package version: `0.9.0`.

## Priority order if implementing next

1. **#70 Local-only models** — biggest user-power unlock; aligns with OpenClaw docs.
2. **#77 Tasks scroll** + **#81 Agents fleet scroll** — small UI fixes, high daily friction.
3. **#73 residual CLI stderr** — harden `runCliJson` for exit-0 + stderr JSON.
4. **#80 reindex path** — clearer errors + memory RPC preference when available.
5. Close the already-fixed cluster (**#75, #76, #78, #82, #84, #85**) with upgrade notes.
6. Handle **#86** privately; close as non-bug.

## Drafts

Ready-to-post GitHub comments (not posted by this audit):

- [`drafts/70.md`](./drafts/70.md) … [`drafts/86.md`](./drafts/86.md)
