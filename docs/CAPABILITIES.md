# Runtime Capability Detection

Mission Control runs the same build in two places: a self-hosted machine and
a hosted AgentBay VPC container. One process resolves, at request time, which
features have a real surface on this instance — never a build variant, never
a compile-time flag. This document is the single source of truth for the six
capability keys, the guard recipes, and the procedure for adding a new key —
read it before gating a new route or component, and read it first if you are
extending this mechanism in a later phase.

## 1. The six capability keys

`src/lib/capabilities.ts` exports `CAPABILITY_KEYS`, a fixed six-key tuple.
Every key is backed by a real UI or API surface that exists in this repo
today — Phase 3 deliberately ships no key without a live surface
(no-placeholders rule).

| Key | Truth condition | Surfaces gated |
|---|---|---|
| `appleCalendar` | not hosted, `platform === "darwin"`, and the `icalBuddy` binary probe succeeds | `GET /api/integrations/apple/events`, `src/lib/apple-calendar.ts` |
| `calendarWorkspace` | not hosted | `/calendar` page, `GET`/`POST /api/calendar`, Calendar nav row, Calendar quick action, the localhost-bound Google OAuth path in `src/lib/google-calendar.ts` |
| `tailscaleNetworking` | not hosted | `/tailscale` page, `GET`/`POST /api/tailscale`, Settings → Tailscale row, Infrastructure hub Tailscale entry |
| `hostInfrastructure` | not hosted | Logs + Backup nav rows, Settings Infrastructure group (Terminal/Config/Browser/Audio), dashboard "Access & pairing" card, OpenClaw + Mission Control update banners, browser-relay extension mode, MCP self-hosted connectors |
| `localGatewayControl` | not hosted | Onboarding "gateway" step, local gateway bootstrap in `onboard/bootstrap.ts`, CLI-transport diagnostic banner |
| `localModelAuth` | not hosted | Onboarding model step: subscription paste-token auth and the local provider (Ollama / LM Studio) chooser |

Five of the six keys share one input (`!hosted`) today. They stay separate
keys, never collapsed into one boolean, because their *reasons* differ and
will diverge — a self-hosted Linux box with no Tailscale installed, a hosted
image that later gains a managed OAuth callback. `appleCalendar` already
diverges: it is `false` on a self-hosted Linux box even though every other
key is `true` there.

`requiresGBrain` is **not** one of these six keys. It stays a separate
gateway-backed runtime probe by design — G-Brain availability is a fact the
gateway reports about itself, not a fact about this MC process's platform,
env, or local binaries, so it does not belong in this module.

## 2. Capability key vs. the `hosted` deployment fact

Two different things travel on the same `GET /api/capabilities` response:

- **A capability key** (`capabilities.<key>`, `CapabilityKey`) is a feature
  gate. It answers "does this surface actually work on this instance right
  now?" and it **fails closed** — any error, any unresolved probe, any
  malformed input resolves every key to `false`, never `true`
  (`computeCapabilities()`'s `=== true` / `=== "darwin"` comparisons, never a
  truthiness check).
- **`hosted`** (`CapabilitySnapshot.hosted`) is a plain deployment fact —
  is this process running on an AgentBay VPC container? It exists **only**
  for copy and branding (page title, hosted-worded onboarding text, a
  hosted-only support card). No feature gate may read `hosted` directly —
  every feature gate reads a capability key through `useCapability()` /
  `useCapabilities()` so it fails closed even if a future capability's
  relationship to `hosted` changes.

Exactly four sites in this repo are permitted to read the `hosted` fact,
because they choose wording, not availability:

1. `src/app/layout.tsx` — the page `<title>`/description (module-scope
   `readHostedFlag()`, evaluated synchronously since Next's `metadata`
   export cannot await the async snapshot)
2. `src/app/layout.tsx`'s `RootLayout` — resolves the full snapshot via
   `getCapabilitySnapshot()` and feeds it into `CapabilityProvider`
3. `src/components/setup-gate.tsx` — the auto-retry error branch and the
   wizard error copy read `hosted` to choose wording, not to decide whether
   to render
4. `src/components/dashboard-view.tsx` — the "Need help" support card reads
   `hosted` to switch its copy, separately from the "Access & pairing" card
   which reads the real `hostInfrastructure` capability key

`src/components/onboarding/step-model.tsx` also reads `hosted`, but only for
its hosted-worded copy branch — its three actual feature gates (subscription
paste-token availability, the Cloud/Subscription/Local chooser, the Skip
button) read `localModelAuth`, never `hosted`.

## 3. Server guard recipe

Call `requireCapability(key)` as the **first statement inside the handler
body**, before any gateway call or side effect:

```ts
export const GET = withRoute<unknown, SomeQuery>(
  { name: "/api/your-route", querySchema: someSchema },
  async (_request, ctx) => {
    const refusal = await requireCapability("tailscaleNetworking");
    if (refusal) return refusal;
    // ...real handler logic, only reached when the capability is present
  },
);
```

`requireCapability()` resolves the snapshot and returns `null` when the key
is present, or the fixed 404 refusal (built through `notFound()`, never a
hand-built `{ ok: false }` literal) when it is absent — including when
resolving the snapshot itself throws. **Never** put the guard in a
`WithRouteOptions` field — it composes with `withRoute`/`withPassthroughRoute`
as ordinary handler-body logic, the same way every other in-handler check
does, so it stays visible in the handler you're reading rather than hidden
in a wrapper option a reviewer has to cross-reference.

`scripts/check-capability-gates.mjs` (`npm run check:capabilities`, wired
into `npm run test:premerge` immediately after `check:contract`) statically
proves every route that imports a capability-constrained lib module also
calls `requireCapability(` somewhere in the same file — a route added later
that imports one of those libs without the guard fails this gate before
merge, closing the elevation-of-privilege gap a future contributor could
otherwise reopen silently.

## 4. Client recipe

Read capabilities only from inside `CapabilityProvider` (mounted in
`src/app/layout.tsx`'s `RootLayout`, fed the server-resolved snapshot as a
prop — no client-side fetch, no loading state):

```tsx
"use client";
import { useCapability } from "@/hooks/use-capabilities";

function TailscaleRow() {
  const tailscaleNetworking = useCapability("tailscaleNetworking");
  if (!tailscaleNetworking) return null;
  return <NavRow ... />;
}
```

`useCapabilities()` returns the full `CapabilitySnapshot`; `useCapability(key)`
returns just one boolean — the common case at a feature-gate call site. The
context default (rendered outside/before the provider, which should never
happen in practice) is `NO_CAPABILITIES` — every key `false` — not `null` and
not `undefined`, so a consumer never needs a null-check: **absent, not
disabled**. A gated element is removed from the tree entirely (hide, never a
greyed-out disabled control), and removing it must never leave dead space, an
orphan section heading, or a doubled separator — filter at the group level
(e.g. a `HubGroup` that filters its own rows and returns `null` when empty)
rather than wrapping each row in its own conditional.

Hoist one `useCapabilities()`/`useCapability()` call per component even when
multiple call sites in that component need it — never call the hook twice in
the same component.

## 5. The refusal

Every capability-gated route that refuses a request answers identically:

```json
{ "ok": false, "error": "This isn't available on your setup." }
```

with HTTP status `404`. `src/lib/capabilities.ts`'s `UNAVAILABLE_MESSAGE` is
the single source of this string — status `404`, not `403`, so the response
never confirms or denies that the gated feature exists on other instances.
No error code, no jargon, no retry affordance (D-02 / UI-SPEC Copywriting
Contract).

## 6. Freshness — TTL and `?refresh=1`

`platform` and the `hosted` flag are read fresh from `process.env` on every
call — never cached, never inlined at build time — so restarting the process
with a different hosted flag changes the served matrix with no rebuild and no
redeploy (CAP-04). Only the `icalBuddy` binary probe is cached, with a
5-minute TTL (`PROBE_TTL_MS` in `src/lib/capability-probes.ts`). Installing or
removing that binary is reflected within the TTL automatically, or
immediately via `GET /api/capabilities?refresh=1`, which calls
`invalidateProbeCache()` before resolving the snapshot — no process restart
required either way. `GET /api/capabilities` always answers with
`cache-control: no-store`, so the browser never serves a stale cached body.

## 7. Adding a capability

Four edits, in this order, close a new capability end-to-end:

1. **Add the key** to `CAPABILITY_KEYS` in `src/lib/capabilities.ts`, and add
   its truth condition inside `computeCapabilities()` — every comparison
   must be `=== true` / `=== "some-literal"`, never a truthiness check, so a
   malformed or missing input still resolves to `false` (fail-closed).
2. **Add the input** the new condition needs to `CapabilityInputs` and
   `getCapabilitySnapshot()` in `src/lib/capability-probes.ts` — a new env
   read, a new binary probe (reuse the `execFile` + ENOENT-catch idiom), or a
   new config fact.
3. **Add the constrained lib** to `CONSTRAINED_LIB_MODULES` in
   `scripts/check-capability-gates.mjs`, if the new capability gates a lib
   module a route imports — this is what makes an ungated route fail
   `npm run check:capabilities` before merge.
4. **Wire the call sites**: `await requireCapability(key)` as the first
   statement in every server route the capability gates, and
   `useCapability(key)` at every client call site that decides whether to
   render.

This is the handoff for Phase 9, which adds `sandbox` and `nodes` capability
keys to this same module once their surfaces exist.
