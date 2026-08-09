# Deploying Mission Control

Mission Control is designed to be the **only gate** in front of an OpenClaw
gateway: every page and every `/api/*` route (including the interactive
terminal at `/api/terminal` and the SSE chat stream at `/api/chat/stream`)
passes through a single auth middleware (`src/middleware.ts`).

One principle to internalize before exposing it anywhere:

> **Secrets are visible in this dashboard by design.** API keys, the gateway
> token, and configuration are readable and writable in the UI. Protection
> comes from authenticating the caller — the modes below — not from hiding
> values. Whoever can open Mission Control can operate OpenClaw completely.

The mode names deliberately mirror OpenClaw's own gateway auth vocabulary
(`token`, `trusted-proxy` — see
[docs.openclaw.ai/gateway/configuration](https://docs.openclaw.ai/gateway/configuration)
and
[docs.openclaw.ai/gateway/trusted-proxy-auth](https://docs.openclaw.ai/gateway/trusted-proxy-auth)),
so an operator who knows OpenClaw already knows these concepts.

## Environment variables

| Variable | Modes | Purpose |
| --- | --- | --- |
| `MISSION_CONTROL_AUTH` | all | `off` (default), `token`, or `trusted-proxy` |
| `MISSION_CONTROL_AUTH_TOKEN` | token | Shared secret the owner types on the login page |
| `MISSION_CONTROL_PROXY_SECRET` | trusted-proxy | Shared secret the hosting platform's proxy injects per request |
| `MISSION_CONTROL_ALLOWED_HOSTS` | off, token | Comma-separated extra `Host`/`Origin` hosts. `host` allows any port, `host:port` that port only |

## Mode: `off` (default) — local single-user

For the classic local setup: `next dev`/`next start` bound to loopback
(`-H 127.0.0.1`) on the same machine as the OpenClaw gateway.

- No login. Anyone who can reach the port has full control, so keep the bind
  loopback-only (the default `npm run dev` already does).
- **Origin/Host validation is still enforced.** Requests whose `Host` or
  `Origin` header is not `localhost`, `127.0.0.1`, or `::1` (any port) — or an
  entry from `MISSION_CONTROL_ALLOWED_HOSTS` — are rejected with `403` JSON.
  This kills DNS-rebinding attacks: a malicious page at `evil.example` that
  rebinds its DNS to `127.0.0.1` still sends `Host: evil.example` and never
  reaches a route.

Accessing the dashboard from another device via a hostname (e.g. a Tailscale
MagicDNS name or a LAN name)? Add it:

```bash
MISSION_CONTROL_ALLOWED_HOSTS="my-machine.tailnet-name.ts.net,mc.lan:3000"
```

## Mode: `token` — one shared secret, built-in login

For a Mission Control instance exposed beyond localhost (VPN, tailnet, or a
TLS-terminated reverse proxy) with a single owner.

```bash
MISSION_CONTROL_AUTH=token
MISSION_CONTROL_AUTH_TOKEN="$(openssl rand -hex 32)"
```

Behavior:

- Unauthenticated page loads redirect to `/login`, a minimal standalone page
  that never depends on the gateway being up.
- Submitting the correct token sets an **httpOnly, SameSite=Lax session
  cookie** (a SHA-256 derivation of the token — the raw token is never stored
  in the cookie) valid for 7 days. The `Secure` flag is set automatically when
  the request arrived over HTTPS (`x-forwarded-proto: https` counts).
- Every `/api/*` request without the cookie gets `401` JSON; token comparison
  is constant-time; failed logins are delayed ~400 ms.
- The Origin/Host allowlist from `off` mode still applies — remember to add
  your public hostname to `MISSION_CONTROL_ALLOWED_HOSTS`:

```bash
MISSION_CONTROL_ALLOWED_HOSTS="mission.example.com"
```

- `POST /api/auth/logout` (or clearing cookies) ends the session. Rotating
  `MISSION_CONTROL_AUTH_TOKEN` invalidates all existing sessions at once.

## Mode: `trusted-proxy` — hosting-platform front end

For platforms that host OpenClaw + Mission Control per customer inside a VPC
and authenticate the owner upstream (OAuth/OIDC/SAML at the platform edge).
Mission Control shows no login page; the platform proxy is the trust boundary
— the same delegation model as OpenClaw's own
[`gateway.auth.mode: "trusted-proxy"`](https://docs.openclaw.ai/gateway/trusted-proxy-auth).

```bash
MISSION_CONTROL_AUTH=trusted-proxy
MISSION_CONTROL_PROXY_SECRET="$(openssl rand -hex 32)"
```

Every request the proxy forwards **must** carry two headers:

| Header | Value |
| --- | --- |
| `x-mission-control-proxy-secret` | Must equal `MISSION_CONTROL_PROXY_SECRET` (constant-time compared) |
| `x-mission-control-user` | Authenticated owner identity, e.g. `owner@example.com` |

Requests missing either header — including direct hits that bypass the proxy —
get `401` JSON. A valid secret replaces the Origin/Host allowlist (the proxy
already pinned the public hostname), so no `MISSION_CONTROL_ALLOWED_HOSTS`
entry is needed. `GET /api/auth/status` echoes `mode`, `authenticated`, and
`user` so the platform can health-check the gate.

Operational requirements, in the same spirit as OpenClaw's trusted-proxy
rules:

1. **The proxy must be the only network path** to Mission Control. Bind
   Mission Control to a private interface; firewall everything else.
2. **The proxy must strip client-supplied** `x-mission-control-proxy-secret`
   and `x-mission-control-user` headers before injecting its own.
3. Treat `MISSION_CONTROL_PROXY_SECRET` like a credential: unique per tenant,
   rotated on schedule.

Example nginx snippet:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header x-mission-control-proxy-secret "<secret>";
    proxy_set_header x-mission-control-user $authenticated_user;
    # SSE endpoints (/api/chat/stream, /api/terminal) need buffering off:
    proxy_buffering off;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 3600s;
}
```

## What the middleware exempts

| Path | Why |
| --- | --- |
| `/login`, `/api/auth/*` | The login flow itself (Origin/Host checks still apply) |
| `/api/usage/internal` | Enforces its own webhook token (`MISSION_CONTROL_USAGE_WEBHOOK_TOKEN` or the gateway token) |
| `/_next/*`, static assets | No secrets served there |

## Streaming

The middleware inspects only headers and cookies and never buffers bodies, so
SSE (`/api/chat/stream`, `/api/terminal`) and the browser relay
(`/api/browser/relay`) stream through unchanged once a request is
authenticated. If you front Mission Control with your own proxy, disable
response buffering for those routes (see the nginx snippet above).

## Verifying a deployment

```bash
# Which mode is live, and is this caller authenticated?
curl -s https://mission.example.com/api/auth/status

# DNS-rebinding protection (expect 403):
curl -s -H "Host: evil.example" http://127.0.0.1:3000/api/auth/status

# Token login (expect a Set-Cookie: mission_control_session=…):
curl -si -X POST https://mission.example.com/api/auth/login \
  -H 'Content-Type: application/json' -d '{"token":"…"}' | grep -i set-cookie
```

The full contract is executable: `e2e/auth.spec.ts` spins up a server in each
mode and asserts every behavior above.
