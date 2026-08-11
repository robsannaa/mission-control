# Implementation plans for issues that stay open

These are engineering plans only — nothing was closed or implemented in this audit PR.

## #70 — Local-only models (P0 feature)

### Goal

A user on a DGX Spark / air-gapped box can run Mission Control end-to-end on Ollama, LM Studio, vLLM, or a custom OpenAI-compatible server without ever pasting a cloud API key — and adding a cloud key later must not steal `agents.defaults.model.primary`.

### Align with OpenClaw

- Docs: [Local models](https://docs.openclaw.ai/gateway/local-models), [Ollama](https://docs.openclaw.ai/providers/ollama)
- Write `models.providers.<id>` with loopback `baseUrl` + non-secret marker (`ollama-local`, `lmstudio`, `sk-local`)
- Set `agents.defaults.model.primary` to `provider/model`
- Prefer `config.patch` over `openclaw config set` (already the house style post-#82)
- Surface `timeoutSeconds` and optional `localModelLean` for smaller GPUs

### Touch points

| Area | Files |
|------|-------|
| Onboarding UI | `src/components/onboarding/step-model.tsx`, wizard types |
| Onboarding API | `src/app/api/onboarding/model-auth/route.ts`, `src/app/api/onboard/route.ts` |
| Models UI | `src/components/models-view.tsx` |
| Models API | `src/app/api/models/route.ts` (`LOCAL_PROVIDERS` already exists) |
| Auth helpers | `src/lib/provider-auth.ts` — allow keyless local probe |
| Doctor | local server reachability check |

### UX sketch

1. Provider chooser: **Local** | Cloud | Subscription
2. Local sub-chooser: Ollama (auto-detect `:11434`) | LM Studio (`:1234`) | Custom URL
3. Probe → model picker → Save as primary
4. Advanced: contextWindow, maxTokens, api mode, timeoutSeconds, lean mode toggle

### Tests

- Unit: config patch shape for ollama / lmstudio / custom
- e2e (mocked): onboarding completes without token; primary preserved when cloud key added later

---

## #77 — Tasks scroll (P1 bug)

### Goal

Desktop kanban columns scroll independently when cards overflow; page does not silently eat wheel events.

### Fix sketch

In `tasks-view.tsx` board region:

1. Outer: keep `md:overflow-y-hidden` only if children are height-bound
2. Grid: `md:h-full md:min-h-0` + `items-stretch` (not `items-start`)
3. Column shell: `md:h-full md:min-h-0 flex flex-col`
4. Card list: existing `flex-1 overflow-y-auto min-h-0` then works

Add Playwright assertion with many cards.

---

## #81 — Agents fleet accessibility (P1 UX)

### Goal

On a phone, every agent is reachable without secret gestures.

### Fix sketch

1. Default `viewMode` to `grid` when `window.matchMedia('(max-width: 768px)')` or via UA on first paint; honor `?view=`
2. Hierarchy: on mount `fitView`, show transient hint “Drag to pan · pinch to zoom”
3. New compact **Fleet** list (optional third mode): virtualized rows, search, status chips — maximum operator power for large orgs
4. Persist preference in `localStorage`

---

## #73 residual — CLI JSON without TTY (P2)

### Goal

Skills (and any `runCliJson` consumer) survive exit-0 empty-stdout stderr-JSON.

### Fix sketch

In `src/lib/openclaw-cli.ts`:

- Prefer `runCliCaptureBoth` inside `runCliJson`
- If stdout has no JSON, parse stderr before throwing “empty output”
- Optionally set `FORCE_COLOR=0` (already `NO_COLOR`) and document headless behavior in Doctor

Keep RPC `skills.status` as primary.

---

## #80 reindex follow-up (P2)

### Goal

Reindex failures explain themselves and never look like “gateway offline”.

### Fix sketch

- `/api/vector` reindex: catch tool/CLI errors → `400/422` with `{ ok:false, code, message, fixHint }`
- UI maps codes to CTAs (pull embedding model, start Ollama, enable local plugin)
- Preflight uses existing provider availability from status payload
