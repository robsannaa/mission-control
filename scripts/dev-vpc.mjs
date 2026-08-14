#!/usr/bin/env node
/**
 * Local "VPC" dev harness — Mission Control exactly as an AgentBay tenant sees
 * it, but running `next dev` so code edits hot-reload and you verify instantly.
 *
 * What it reproduces 1:1 from a real agentbay-openclaw tenant + its Caddy edge
 * (verified against agentbay-prod, 2026-08):
 *
 *   • Hosted flags:  AGENTBAY_HOSTED=true, NEXT_PUBLIC_AGENTBAY_HOSTED=true
 *     → Calendar disabled, hosted onboarding/copy, version chip via pkg fallback.
 *   • Read-only:     OPENCLAW_READ_ONLY=true (as customer tenants run). Flip with
 *     VPC_READ_ONLY=false when you need to exercise write flows.
 *   • Front door:    MISSION_CONTROL_AUTH=trusted-proxy. The app is only
 *     reachable through this proxy — a direct hit to the app port returns 401,
 *     exactly like a tenant whose container is firewalled behind Caddy.
 *   • Edge headers:  the proxy DELETES any client-supplied
 *     x-mission-control-proxy-secret / x-mission-control-user (anti-spoof), then
 *     INJECTS the shared secret + owner identity — byte-for-byte what the
 *     dev-tenant Caddy route does before forwarding.
 *
 * Usage:
 *   npm run dev:vpc                 # open http://127.0.0.1:8890
 *   VPC_READ_ONLY=false npm run dev:vpc
 *   APP_PORT=3400 PUBLIC_PORT=9000 VPC_OWNER=me@example.com npm run dev:vpc
 */

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_HOST = "127.0.0.1";
const APP_PORT = Number(process.env.APP_PORT || 3100);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 8890);
const OWNER = process.env.VPC_OWNER || "roberto.sannazzaro@att.eu";
const READ_ONLY = process.env.VPC_READ_ONLY !== "false"; // default true (1:1 tenant)

// Empty-tenant mode (VPC_EMPTY=1): spin an ISOLATED OpenClaw gateway on a fresh
// home with no model configured — a brand-new AgentBay tenant. Mission Control
// then auto-triggers onboarding. Fully sandboxed from the user's real
// ~/.openclaw. `VPC_RESET=1` wipes the demo home first for a clean run.
const EMPTY = process.env.VPC_EMPTY === "1" || process.env.VPC_EMPTY === "true";
const VPC_HOME = process.env.VPC_HOME || join(homedir(), ".openclaw-vpc-demo");
const GW_PORT = Number(process.env.VPC_GATEWAY_PORT || 18795);
const RESET = process.env.VPC_RESET === "1" || process.env.VPC_RESET === "true";
// OpenClaw refuses an overridden gateway URL without explicit credentials, even
// for an auth-less gateway — so the demo gateway runs token auth and MC gets the
// same token, satisfying both the WS transport and CLI-spawned calls.
const GW_TOKEN = process.env.VPC_GATEWAY_TOKEN || crypto.randomBytes(24).toString("hex");

const SECRET_HEADER = "x-mission-control-proxy-secret";
const USER_HEADER = "x-mission-control-user";

// Persist a stable proxy secret across restarts (gitignored).
const secretFile = join(ROOT, ".vpc-proxy-secret");
let SECRET = (process.env.MISSION_CONTROL_PROXY_SECRET || "").trim();
if (!SECRET) {
  if (existsSync(secretFile)) SECRET = readFileSync(secretFile, "utf8").trim();
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString("hex");
    writeFileSync(secretFile, SECRET + "\n", { mode: 0o600 });
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net
      .connect({ host: APP_HOST, port }, () => {
        probe.destroy();
        resolve(true);
      })
      .on("error", () => resolve(false));
    probe.setTimeout(500, () => {
      probe.destroy();
      resolve(false);
    });
  });
}

function waitForApp(port, tries = 120) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const probe = net
        .connect({ host: APP_HOST, port }, () => {
          probe.destroy();
          resolve();
        })
        .on("error", () => {
          if (--tries <= 0) return reject(new Error("app never came up"));
          setTimeout(tick, 500);
        });
    };
    tick();
  });
}

// The Caddy-edge contract: drop client identity headers, then set our own.
// Exported as a factory so the edge can be exercised in isolation (see
// scripts/__tests__ / the harness verification) without booting next dev.
export function makeEdgeHeaders({ secret, owner, appHost, appPort }) {
  return function edgeHeaders(incoming) {
    const h = { ...incoming };
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === SECRET_HEADER || lk === USER_HEADER) delete h[k];
    }
    h[SECRET_HEADER] = secret;
    h[USER_HEADER] = owner;
    h.host = `${appHost}:${appPort}`;
    return h;
  };
}

/** Build the reverse-proxy "edge" server (request + upgrade), pointed at an
 *  upstream app. Strips + injects identity headers and streams bodies. */
export function createEdgeProxy({ appHost, appPort, secret, owner }) {
  const edgeHeaders = makeEdgeHeaders({ secret, owner, appHost, appPort });

  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: appHost,
        port: appPort,
        method: req.method,
        path: req.url,
        headers: edgeHeaders(req.headers),
      },
      (up) => {
        // The upstream response stream can error mid-flight (client vanished);
        // swallow it so a dropped SSE/HMR connection never crashes the proxy.
        up.on("error", () => res.destroy());
        if (!res.headersSent) res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res); // no buffering → SSE (/api/chat/stream) streams through
      },
    );
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`vpc edge: upstream error: ${e.message}`);
      } else {
        res.destroy();
      }
    });
    // When the browser drops the connection (navigate away, close an SSE
    // stream), tear down the upstream and ignore the resulting EPIPE/ECONNRESET
    // instead of letting an unhandled 'error' event kill the process.
    req.on("error", () => upstream.destroy());
    res.on("error", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  // websocket / upgrade passthrough (terminal, browser relay)
  proxy.on("upgrade", (req, socket, head) => {
    const up = http.request({
      host: appHost,
      port: appPort,
      method: req.method,
      path: req.url,
      headers: edgeHeaders(req.headers),
    });
    // A closed client/upstream socket must never throw an unhandled 'error'.
    socket.on("error", () => socket.destroy());
    up.on("upgrade", (upRes, upSocket, upHead) => {
      upSocket.on("error", () => upSocket.destroy());
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upHead?.length) upSocket.unshift(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    up.on("error", () => socket.destroy());
    if (head?.length) up.write(head);
    up.end();
  });

  return proxy;
}

async function main() {
  // Last-resort net: benign disconnect errors (a client vanishing mid-stream)
  // should never crash the dev harness. Ignore those; re-throw anything real.
  process.on("uncaughtException", (err) => {
    if (err && (err.code === "EPIPE" || err.code === "ECONNRESET")) return;
    throw err;
  });

  if (await portInUse(APP_PORT)) {
    console.error(
      `\n  Port ${APP_PORT} is already in use — likely your existing "npm run dev".\n` +
        `  dev:vpc IS your dev server (just VPC-fronted), so stop the other one and re-run,\n` +
        `  or pick a free port:  APP_PORT=3400 npm run dev:vpc\n`,
    );
    process.exit(1);
  }

  // Empty-tenant: stand up an isolated, model-less gateway on a fresh home so
  // Mission Control sees a brand-new AgentBay tenant and auto-triggers onboarding.
  let gateway = null;
  if (EMPTY) {
    if (RESET && existsSync(VPC_HOME)) rmSync(VPC_HOME, { recursive: true, force: true });
    mkdirSync(VPC_HOME, { recursive: true });
    console.log(
      `\n  Empty tenant: starting an isolated OpenClaw gateway on :${GW_PORT}\n` +
        `  home: ${VPC_HOME}/.openclaw  (fresh, no model → onboarding triggers)\n`,
    );
    // Token auth: MC overrides the gateway URL, and OpenClaw requires explicit
    // credentials for an overridden URL (config creds are never reused) — even
    // an --auth none gateway would make CLI-spawned calls throw
    // GatewayExplicitAuthRequiredError. Give it a token and hand MC the same one.
    gateway = spawn(
      "openclaw",
      ["gateway", "--dev", "--auth", "token", "--token", GW_TOKEN, "--force", "--port", String(GW_PORT)],
      { env: { ...process.env, OPENCLAW_HOME: VPC_HOME, OPENCLAW_GATEWAY_TOKEN: GW_TOKEN }, stdio: "inherit" },
    );
    gateway.on("exit", (c) => c && console.error(`\n  isolated gateway exited (code ${c})\n`));
    try {
      await waitForApp(GW_PORT);
    } catch {
      console.error("  isolated gateway did not open its port in time — continuing anyway\n");
    }
  }

  const childEnv = {
    ...process.env,
    AGENTBAY_HOSTED: "true",
    NEXT_PUBLIC_AGENTBAY_HOSTED: "true",
    // Onboarding must WRITE config to complete, so the empty tenant is not read-only.
    OPENCLAW_READ_ONLY: EMPTY ? "false" : READ_ONLY ? "true" : "false",
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
    MISSION_CONTROL_AUTH: "trusted-proxy",
    MISSION_CONTROL_PROXY_SECRET: SECRET,
  };
  if (EMPTY) {
    // Point MC at the isolated home + gateway; drop any inherited token so it
    // reads the dev gateway's own credential from that home's config.
    childEnv.OPENCLAW_HOME = VPC_HOME;
    childEnv.OPENCLAW_GATEWAY_URL = `http://127.0.0.1:${GW_PORT}`;
    childEnv.OPENCLAW_GATEWAY_TOKEN = GW_TOKEN;
  }

  // 1) next dev (hot reload), bound to loopback — the "container".
  const dev = spawn(
    "npx",
    ["next", "dev", "-H", APP_HOST, "-p", String(APP_PORT), "--webpack"],
    { cwd: ROOT, env: childEnv, stdio: "inherit" },
  );

  // 2) the reverse-proxy "edge" — strips + injects, streams bodies (SSE-safe).
  const proxy = createEdgeProxy({
    appHost: APP_HOST,
    appPort: APP_PORT,
    secret: SECRET,
    owner: OWNER,
  });

  const shutdown = () => {
    try {
      dev.kill("SIGTERM");
    } catch {}
    try {
      gateway?.kill("SIGTERM");
    } catch {}
    try {
      proxy.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  dev.on("exit", (code) => {
    try {
      gateway?.kill("SIGTERM");
    } catch {}
    try {
      proxy.close();
    } catch {}
    process.exit(code || 0);
  });

  try {
    await waitForApp(APP_PORT);
  } catch {
    /* proxy still starts; app may just be slow to compile */
  }

  proxy.listen(PUBLIC_PORT, APP_HOST, () => {
    const line = "─".repeat(58);
    console.log(
      `\n${line}\n` +
        `  Mission Control — local VPC (AgentBay-tenant 1:1, hot reload)\n` +
        `${line}\n` +
        `  Open:        http://${APP_HOST}:${PUBLIC_PORT}\n` +
        `  Owner:       ${OWNER}\n` +
        (EMPTY
          ? `  Tenant:      EMPTY — fresh home ${VPC_HOME}/.openclaw, gateway :${GW_PORT}\n` +
            `               (no model → onboarding auto-triggers)\n`
          : `  Read-only:   ${READ_ONLY} ${READ_ONLY ? "(VPC_READ_ONLY=false to disable)" : ""}\n`) +
        `  Auth:        trusted-proxy  (direct :${APP_PORT} returns 401 by design)\n` +
        `  Hosted:      AGENTBAY_HOSTED + NEXT_PUBLIC_AGENTBAY_HOSTED = true\n` +
        `${line}\n`,
    );
  });
}

// Only launch when run directly (`node scripts/dev-vpc.mjs`) — importing the
// module for tests must not spawn next dev or bind ports.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
