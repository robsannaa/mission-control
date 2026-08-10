/**
 * Redaction for anything that leaves the machine.
 *
 * Doctor output names real config paths and, in the security check, lists the
 * *keys* that hold plaintext secrets. It does not print the values — but the
 * raw CLI transcript we keep for the report can pick up a token from an
 * unrelated line, and `~` expansion leaks the operator's username. Both get
 * scrubbed before a finding is stored or shared.
 *
 * The known-secret pass reads the real values out of openclaw.json and masks
 * those exact strings. That is the only reliable way to catch a token that
 * appears in output we did not anticipate — pattern matching alone would miss a
 * short or unusual token and would false-positive on ordinary hashes.
 */

import { homedir } from "os";
import { readFileSync } from "fs";
import { join } from "path";
import { getOpenClawHome } from "./paths";

const REDACTED = "[redacted]";

/** Config paths whose values must never appear in output we persist or share. */
const SECRET_CONFIG_PATHS = [
  ["gateway", "auth", "token"],
  ["gateway", "auth", "password"],
  ["messages", "tts", "providers", "elevenlabs", "apiKey"],
  ["channels", "telegram", "botToken"],
  ["channels", "discord", "token"],
  ["channels", "slack", "botToken"],
  ["channels", "whatsapp", "token"],
];

let knownSecrets: string[] | null = null;

function collectKnownSecrets(): string[] {
  if (knownSecrets) return knownSecrets;
  const found: string[] = [];
  try {
    const raw = readFileSync(join(getOpenClawHome(), "openclaw.json"), "utf-8");
    const config = JSON.parse(raw) as unknown;
    for (const path of SECRET_CONFIG_PATHS) {
      let node: unknown = config;
      for (const key of path) {
        if (!node || typeof node !== "object") {
          node = undefined;
          break;
        }
        node = (node as Record<string, unknown>)[key];
      }
      // Short values are more likely to be a mode name than a credential, and
      // masking a 4-character string would corrupt unrelated prose.
      if (typeof node === "string" && node.length >= 8) found.push(node);
    }
  } catch {
    // No config, or unreadable — pattern redaction still applies.
  }
  knownSecrets = found;
  return knownSecrets;
}

/** Drop the memoised secret list (call after a token rotation). */
export function invalidateRedactionCache(): void {
  knownSecrets = null;
}

/**
 * Patterns for credential shapes doctor output is known to carry: bearer
 * tokens, `sk-`/`ghp_` style provider keys, and long opaque hex blobs. Applied
 * after the known-value pass so a masked token is not double-processed.
 */
const PATTERNS: { re: RegExp; replace: string }[] = [
  { re: /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { re: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, replace: REDACTED }, // telegram bot token
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: REDACTED }, // jwt
  { re: /\b[a-f0-9]{40,}\b/gi, replace: REDACTED },
  { re: /(Authorization:\s*Bearer\s+)\S+/gi, replace: `$1${REDACTED}` },
  { re: /(--token[= ])\S+/g, replace: `$1${REDACTED}` },
];

/**
 * Scrub one string. Safe to call repeatedly — redaction is idempotent because
 * `[redacted]` matches none of the patterns.
 */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;

  for (const secret of collectKnownSecrets()) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace);

  // Collapse the operator's home directory last, so path-shaped secrets above
  // are still matched against their full form.
  const home = homedir();
  if (home && home !== "/") out = out.split(home).join("~");

  return out;
}

export function redactAll(inputs: readonly string[]): string[] {
  return inputs.map(redact);
}
