#!/usr/bin/env node
/**
 * Quick onboarding reset for the empty VPC tenant — review every step from
 * scratch without restarting the gateway or next dev.
 *
 * Wipes, in the demo home only (default ~/.openclaw-vpc-demo):
 *   • the saved model / API keys / auth profiles / channels  → `needsSetup` true again
 *   • the persisted onboarding progress                       → wizard restarts at step 1
 *
 * Then just reload http://127.0.0.1:8890. Instant (no process restart).
 * Never touches your real ~/.openclaw.
 *
 *   npm run vpc:reset
 *   VPC_HOME=/some/other/home npm run vpc:reset
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const HOME = process.env.VPC_HOME || join(homedir(), ".openclaw-vpc-demo");
const STATE = join(HOME, ".openclaw");
const configPath = join(STATE, "openclaw.json");
const onboardingPath = join(STATE, "mission-control", "onboarding.json");

// Guard: only ever operate on a demo home, never a real ~/.openclaw.
if (STATE === join(homedir(), ".openclaw")) {
  console.error("\n  Refusing to reset your real ~/.openclaw. Set VPC_HOME to a demo home.\n");
  process.exit(1);
}

const cleared = [];

if (existsSync(configPath)) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    if (cfg.agents?.defaults?.model) {
      delete cfg.agents.defaults.model;
      cleared.push("model");
    }
    if (cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length) {
      cfg.auth.profiles = {};
      cleared.push("auth profiles");
    }
    if (cfg.env && Object.keys(cfg.env).length) {
      cfg.env = {};
      cleared.push("API keys");
    }
    if (cfg.channels) {
      delete cfg.channels;
      cleared.push("channels");
    }
    if (cfg.models?.providers) {
      delete cfg.models.providers;
      cleared.push("custom providers");
    }
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  } catch (e) {
    console.error("  config reset skipped:", e.message);
  }
}

if (existsSync(onboardingPath)) {
  rmSync(onboardingPath, { force: true });
  cleared.push("onboarding progress");
}

console.log(
  `\n  Onboarding reset — ${HOME}\n` +
    `  cleared: ${cleared.length ? cleared.join(", ") : "nothing (already empty)"}\n` +
    `  → reload http://127.0.0.1:8890 to review from step 1\n`,
);
