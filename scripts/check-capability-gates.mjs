#!/usr/bin/env node
/**
 * check-capability-gates — the static audit that closes both halves of
 * CAP-01 (single source of the legacy hosted-flag reads) and CAP-03 (every
 * capability-constrained route calls `requireCapability()`). Mirrors
 * `scripts/check-api-contract.mjs`'s structure and comment-stripping
 * approach (03-01-PLAN.md Task 3) rather than inventing a second
 * convention — dependency-free, plain ESM Node, no build step.
 *
 * Two violation classes, both scoped under `src/`:
 *
 *   (1) legacy-flag-read — a reference to `AGENTBAY_HOSTED` (which also
 *       matches `NEXT_PUBLIC_AGENTBAY_HOSTED` as a substring) outside the
 *       single allowlisted reader, `src/lib/capability-probes.ts` (D-07).
 *       Comment stripping is load-bearing: a prose mention in a comment
 *       must not fail the gate, and a bare unfiltered count would be
 *       self-invalidating against this script's own header comment.
 *
 *   (2) ungated-constrained-route — a `src/app/api/**` file named
 *       `route.ts` that imports a capability-constrained lib module (the
 *       CONSTRAINED_LIB_MODULES list below) without calling
 *       `requireCapability(`. Adding a module to that list is how a future
 *       capability-constrained lib gets enforcement coverage from this
 *       script.
 *
 * Usage:
 *   node scripts/check-capability-gates.mjs [--scope <path>]... [--json]
 *
 *   --scope <path>   Limit the scan to a subtree of src (repeatable).
 *                     Accepts a directory or a single file. Defaults to
 *                     the whole src tree.
 *   --json           Print machine-readable JSON instead of the text
 *                     report. In this mode stdout carries ONLY the JSON
 *                     payload (the --silent lesson from Phase 02 Plan 03).
 *
 * Exit code is non-zero when either violation class is non-empty in scope.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC_ROOT = join(ROOT, "src");

// The single file permitted to read the legacy hosted env flags (D-07).
const ALLOWLISTED_LEGACY_FLAG_READER = "src/lib/capability-probes.ts";

// Lib modules whose behavior is capability-constrained today. Adding a
// module here is how a future capability-constrained module gets
// enforcement coverage from this script.
const CONSTRAINED_LIB_MODULES = [
  "@/lib/apple-calendar",
  "@/lib/calendar-store",
  "@/lib/calendar-sync",
  "@/lib/google-calendar",
  "@/lib/tailscale",
];

const LEGACY_FLAG_RE = /AGENTBAY_HOSTED/g;
const REQUIRE_CAPABILITY_RE = /\brequireCapability\(/;

// ── CLI args ────────────────────────────────────────

function parseArgs(argv) {
  const scopes = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scope") {
      const value = argv[i + 1];
      if (!value) {
        console.error("--scope requires a path argument");
        process.exit(2);
      }
      scopes.push(value);
      i++;
    } else if (arg === "--json") {
      json = true;
    }
  }
  return { scopes, json };
}

// ── File discovery ──────────────────────────────────

/**
 * `path` may itself be a single file (a `--scope` pointing directly at one
 * route file) or a directory to recurse into. Scans `.ts` and `.tsx`
 * source, skipping test files entirely — a test legitimately referencing
 * the legacy flag name (e.g. `vi.stubEnv("AGENTBAY_HOSTED", ...)`) must
 * never trip the legacy-flag-read gate.
 */
function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry), out);
    }
    return;
  }
  const ext = extname(path);
  const isSource = ext === ".ts" || ext === ".tsx";
  const isTest = path.endsWith(".test.ts") || path.endsWith(".test.tsx");
  if (isSource && !isTest) {
    out.push(path);
  }
}

function resolveScopeRoots(scopes) {
  if (scopes.length === 0) return [SRC_ROOT];
  return scopes.map((scope) => {
    // Accept both a repo-relative path ("src/app/api/calendar") and a path
    // already rooted under src ("app/api/calendar") — either may name a
    // directory or a single file.
    const asGiven = join(ROOT, scope);
    try {
      statSync(asGiven);
      return asGiven;
    } catch {
      // fall through to the src-relative interpretation below
    }
    return join(SRC_ROOT, scope);
  });
}

function collectFiles(scopes) {
  const roots = resolveScopeRoots(scopes);
  const files = [];
  for (const root of roots) {
    walk(root, files);
  }
  // De-dupe (overlapping --scope values) and sort for deterministic output.
  return [...new Set(files)].sort();
}

// ── Comment stripping (string/template-aware) ───────
//
// Produces same-length output so line numbers computed against it match the
// original source. Comment characters are blanked, not removed. Copied from
// check-api-contract.mjs rather than reinventing a second convention.

function stripComments(source) {
  let result = "";
  let i = 0;
  const n = source.length;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = null; // ' " `

  while (i < n) {
    const c = source[i];
    const c2 = i + 1 < n ? source[i + 1] : "";

    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        result += c;
      } else {
        result += " ";
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (c === "*" && c2 === "/") {
        inBlockComment = false;
        result += "  ";
        i += 2;
        continue;
      }
      result += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }

    if (inString) {
      if (c === "\\" && i + 1 < n) {
        result += c + source[i + 1];
        i += 2;
        continue;
      }
      result += c;
      if (c === inString) inString = null;
      i++;
      continue;
    }

    if (c === "/" && c2 === "/") {
      inLineComment = true;
      result += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && c2 === "*") {
      inBlockComment = true;
      result += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      result += c;
      i++;
      continue;
    }

    result += c;
    i++;
  }
  return result;
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

// ── Violation detectors ──────────────────────────────

function findLegacyFlagViolations(codeText, relPath) {
  if (relPath === ALLOWLISTED_LEGACY_FLAG_READER) return [];
  const violations = [];
  for (const match of codeText.matchAll(LEGACY_FLAG_RE)) {
    violations.push({
      file: relPath,
      line: lineAt(codeText, match.index),
      kind: "legacy-flag-read",
      detail: "reads the legacy hosted env flag directly — read it through src/lib/capability-probes.ts instead",
    });
  }
  return violations;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findUngatedRouteViolations(codeText, relPath, absPath) {
  const basename = absPath.split("/").pop();
  if (basename !== "route.ts") return [];
  if (!relPath.startsWith("src/app/api/")) return [];
  if (REQUIRE_CAPABILITY_RE.test(codeText)) return [];

  for (const moduleName of CONSTRAINED_LIB_MODULES) {
    const importRe = new RegExp(`from\\s+["']${escapeRegExp(moduleName)}["']`);
    const match = importRe.exec(codeText);
    if (!match) continue;
    return [
      {
        file: relPath,
        line: lineAt(codeText, match.index),
        kind: "ungated-constrained-route",
        detail: `imports ${moduleName} (capability-constrained) but never calls requireCapability(`,
      },
    ];
  }
  return [];
}

// ── Main ──────────────────────────────────────────

function main() {
  const { scopes, json } = parseArgs(process.argv.slice(2));
  const files = collectFiles(scopes);

  const violations = { "legacy-flag-read": [], "ungated-constrained-route": [] };

  for (const absPath of files) {
    const relPath = relative(ROOT, absPath);
    const source = readFileSync(absPath, "utf8");
    const codeText = stripComments(source);

    violations["legacy-flag-read"].push(...findLegacyFlagViolations(codeText, relPath));
    violations["ungated-constrained-route"].push(...findUngatedRouteViolations(codeText, relPath, absPath));
  }

  const counts = {
    "legacy-flag-read": violations["legacy-flag-read"].length,
    "ungated-constrained-route": violations["ungated-constrained-route"].length,
  };
  const totalViolations = counts["legacy-flag-read"] + counts["ungated-constrained-route"];
  const ok = totalViolations === 0;

  if (json) {
    process.stdout.write(
      JSON.stringify({ ok, scanned: files.length, counts, violations }) + "\n",
    );
  } else {
    const lines = [];
    lines.push(`Scanned ${files.length} file(s) under: ${scopes.length ? scopes.join(", ") : "src"}`);
    lines.push("");
    lines.push("Violations:");
    lines.push(`  legacy-flag-read:          ${counts["legacy-flag-read"]}`);
    lines.push(`  ungated-constrained-route: ${counts["ungated-constrained-route"]}`);
    lines.push("");
    for (const kind of ["legacy-flag-read", "ungated-constrained-route"]) {
      for (const v of violations[kind]) {
        lines.push(`  ${v.file}:${v.line}  [${v.kind}]  ${v.detail}`);
      }
    }
    lines.push("");
    lines.push(ok ? "PASS: no violations found in scope" : `FAIL: ${totalViolations} violation(s) found in scope`);
    process.stdout.write(lines.join("\n") + "\n");
  }

  process.exit(ok ? 0 : 1);
}

main();
