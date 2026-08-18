#!/usr/bin/env node
/**
 * check-api-contract — the shared, objective acceptance gate every wave-4
 * batch plan (02-05 .. 02-12) uses to prove a directory is fully migrated
 * onto docs/API-CONTRACT.md's error envelope and the withRoute /
 * withPassthroughRoute wrappers (02-03-PLAN.md Task 3).
 *
 * Dependency-free, plain ESM Node — no build step, matching the house style
 * of scripts/dev-vpc.mjs and bin/cli.mjs. Not a JS parser: it does enough
 * balanced-bracket / string-aware scanning to find response-construction
 * call sites and their body literal, without pulling in a real parser.
 *
 * Usage:
 *   node scripts/check-api-contract.mjs [--scope <path>]... [--json]
 *
 *   --scope <path>   Limit the scan to a subtree of src/app/api (repeatable).
 *                     Defaults to the whole src/app/api tree.
 *   --json           Print machine-readable JSON instead of the text report.
 *                     In this mode stdout carries ONLY the JSON payload.
 *
 * Exit code is non-zero when any envelope, logging, or passthrough
 * violation is found in scope. The informational "not yet migrated" count
 * never affects the exit code.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const API_ROOT = join(ROOT, "src", "app", "api");

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

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (extname(full) === ".ts" && !full.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

function resolveScopeRoots(scopes) {
  if (scopes.length === 0) return [API_ROOT];
  return scopes.map((scope) => {
    // Accept both a repo-relative path ("src/app/api/agents") and a path
    // already rooted under src/app/api ("agents") — batch plans and the
    // acceptance criteria in 02-03-PLAN.md use the former.
    const asGiven = join(ROOT, scope);
    try {
      const st = statSync(asGiven);
      if (st.isDirectory()) return asGiven;
    } catch {
      // fall through to the API-relative interpretation below
    }
    return join(API_ROOT, scope);
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
// original source. Comment characters are blanked, not removed. Does not
// special-case regex literals — acceptable for a mechanical, dependency-free
// scanner over this codebase's route files (D-13, see PLAN Task 3 note).

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

/**
 * Extract the text between a balanced pair of parens/brackets starting at
 * `openIndex` (the index of the opening character). String/template
 * literals are respected so a stray bracket inside a string never throws
 * off the match.
 */
function extractBalanced(source, openIndex) {
  const open = source[openIndex];
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { text: source.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}

/** Split a balanced-args string into its top-level (depth-0) comma segments. */
function splitTopLevelArgs(argsText) {
  const parts = [];
  let depth = 0;
  let inString = null;
  let start = 0;
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(argsText.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ── Violation detectors ──────────────────────────────

const RESPONSE_JSON_RE = /\bNextResponse\.json\(|(?<!Next)\bResponse\.json\(/g;
const RAW_RESPONSE_RE = /\bnew\s+Response\(\s*JSON\.stringify\(/g;
const CONSOLE_RE = /\bconsole\.(log|warn|error|info|debug|trace)\(/g;
const STREAM_CONSTRUCT_RE = /new\s+ReadableStream\s*\(|new\s+TransformStream\s*\(|text\/event-stream/;
const STRICT_WRAPPER_RE = /\bwithRoute\(/;
const EITHER_WRAPPER_RE = /\bwithRoute\(|\bwithPassthroughRoute\(/;

function findEnvelopeViolations(codeText, relPath) {
  const violations = [];

  // NextResponse.json(...) / Response.json(...) — body is the first top-level arg.
  for (const match of codeText.matchAll(RESPONSE_JSON_RE)) {
    const openParen = match.index + match[0].length - 1;
    const balanced = extractBalanced(codeText, openParen);
    if (!balanced) continue;
    const [body] = splitTopLevelArgs(balanced.text);
    if (!body) continue;
    if (isUnmarkedErrorBody(body)) {
      violations.push({ file: relPath, line: lineAt(codeText, match.index), kind: "envelope", detail: "response body opens with `error` but has no `ok: false`" });
    }
  }

  // new Response(JSON.stringify(...), ...) — body is JSON.stringify's own first arg.
  for (const match of codeText.matchAll(RAW_RESPONSE_RE)) {
    const openParen = match.index + match[0].length - 1;
    const balanced = extractBalanced(codeText, openParen);
    if (!balanced) continue;
    const [body] = splitTopLevelArgs(balanced.text);
    if (!body) continue;
    if (isUnmarkedErrorBody(body)) {
      violations.push({ file: relPath, line: lineAt(codeText, match.index), kind: "envelope", detail: "new Response(JSON.stringify(...)) body opens with `error` but has no `ok: false`" });
    }
  }

  return violations;
}

function isUnmarkedErrorBody(bodyText) {
  const trimmed = bodyText.trim();
  if (!/^\{\s*error\s*:/.test(trimmed)) return false;
  return !/\bok\s*:\s*false\b/.test(trimmed);
}

function findLoggingViolations(codeText, relPath) {
  const violations = [];
  for (const match of codeText.matchAll(CONSOLE_RE)) {
    violations.push({
      file: relPath,
      line: lineAt(codeText, match.index),
      kind: "logging",
      detail: `bare ${match[0].slice(0, -1)}(...) call — use the injected ctx.log instead`,
    });
  }
  return violations;
}

function findPassthroughViolations(codeText, relPath) {
  if (!STREAM_CONSTRUCT_RE.test(codeText)) return [];
  const strictMatch = STRICT_WRAPPER_RE.exec(codeText);
  if (!strictMatch) return [];
  return [
    {
      file: relPath,
      line: lineAt(codeText, strictMatch.index),
      kind: "passthrough",
      detail: "file constructs a stream/event-source response but also references withRoute — use withPassthroughRoute instead",
    },
  ];
}

function isUnmigratedRouteFile(codeText, basename) {
  return basename === "route.ts" && !EITHER_WRAPPER_RE.test(codeText);
}

// ── Main ──────────────────────────────────────────

function main() {
  const { scopes, json } = parseArgs(process.argv.slice(2));
  const files = collectFiles(scopes);

  const violations = { envelope: [], logging: [], passthrough: [] };
  let unmigratedRouteFiles = 0;

  for (const absPath of files) {
    const relPath = relative(ROOT, absPath);
    const source = readFileSync(absPath, "utf8");
    const codeText = stripComments(source);

    violations.envelope.push(...findEnvelopeViolations(codeText, relPath));
    violations.logging.push(...findLoggingViolations(codeText, relPath));
    violations.passthrough.push(...findPassthroughViolations(codeText, relPath));

    if (isUnmigratedRouteFile(codeText, absPath.split("/").pop())) {
      unmigratedRouteFiles++;
    }
  }

  const counts = {
    envelope: violations.envelope.length,
    logging: violations.logging.length,
    passthrough: violations.passthrough.length,
  };
  const totalViolations = counts.envelope + counts.logging + counts.passthrough;
  const ok = totalViolations === 0;

  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok,
        scanned: files.length,
        counts,
        violations,
        informational: { unmigratedRouteFiles },
      }) + "\n",
    );
  } else {
    const lines = [];
    lines.push(`Scanned ${files.length} file(s) under: ${scopes.length ? scopes.join(", ") : "src/app/api"}`);
    lines.push("");
    lines.push("Violations:");
    lines.push(`  envelope:    ${counts.envelope}`);
    lines.push(`  logging:     ${counts.logging}`);
    lines.push(`  passthrough: ${counts.passthrough}`);
    lines.push("");
    lines.push("Informational (does not affect exit code):");
    lines.push(`  route files not yet importing withRoute/withPassthroughRoute: ${unmigratedRouteFiles}`);
    lines.push("");
    for (const kind of ["envelope", "logging", "passthrough"]) {
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
