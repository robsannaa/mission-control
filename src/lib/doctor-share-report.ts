/**
 * One honest report the user can hand to whoever is helping them.
 *
 * Design constraints, in order:
 *
 * 1. **Redacted.** Every string passes through `redact()` on the way in, and
 *    the report never includes the raw transcript unless explicitly asked for
 *    (and even then it is the already-redacted copy).
 * 2. **Honest about what was not checked.** The provenance table lists every
 *    source, whether it ran, and how long it took. A source that failed appears
 *    with its error rather than being omitted — a helper needs to know the
 *    difference between "clean" and "never looked".
 * 3. **Readable without the UI.** Plain Markdown, no colour, no emoji-encoded
 *    meaning. Someone pasting this into a support thread should be able to act
 *    on it.
 */

import { redact } from "./doctor-redact";
import type { DoctorSnapshot, DoctorSourceRun } from "./doctor-types";

function ago(ms: number | null): string {
  if (ms == null) return "never";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} day(s) ago`;
}

function sourceRow(name: string, run: DoctorSourceRun): string {
  if (!run.ran) return `| ${name} | not run | — | — |`;
  const state = run.ok ? "ok" : `failed — ${redact(run.error ?? "unknown")}`;
  const duration = run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—";
  return `| ${name} | ${state} | ${duration} | \`${redact(run.invocation)}\` |`;
}

export function renderReportMarkdown(
  snapshot: DoctorSnapshot,
  options: { includeTranscript?: boolean; transcript?: string } = {},
): string {
  const lines: string[] = [];
  const health = snapshot.health;

  lines.push("# OpenClaw health report");
  lines.push("");
  lines.push(`Generated ${new Date(snapshot.ts).toISOString()}`);
  lines.push("");

  // ── Headline ──
  if (health.state === "never-checked") {
    lines.push("**This system has never been checked.** There is no score to report.");
  } else if (health.score == null) {
    lines.push(`**Health: unknown.** ${health.caveats.join(" ")}`);
  } else {
    lines.push(
      `**Health: ${health.score}/100 (${health.grade})** — checked ${ago(health.ageMs)}${
        health.state === "stale" ? ", which is old enough that it may no longer be current" : ""
      }.`,
    );
  }
  lines.push("");
  lines.push(
    `${snapshot.summary.errors} error(s), ${snapshot.summary.warnings} warning(s), ${snapshot.summary.infos} informational. ${snapshot.coverage.statement}`,
  );
  lines.push("");

  if (health.caveats.length) {
    lines.push("## What was not verified");
    lines.push("");
    for (const caveat of health.caveats) lines.push(`- ${redact(caveat)}`);
    lines.push("");
  }

  // ── Provenance ──
  lines.push("## Where this came from");
  lines.push("");
  lines.push("| Source | Result | Time | Command |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(sourceRow("Read-only checks", snapshot.provenance.lint));
  lines.push(sourceRow("Full check", snapshot.provenance.legacy));
  lines.push(sourceRow("Security audit", snapshot.provenance.securityAudit));
  lines.push(sourceRow("Credential audit", snapshot.provenance.secretsAudit));
  lines.push(sourceRow("Live gateway status", snapshot.provenance.runtime));
  lines.push("");

  // ── Environment ──
  lines.push("## System");
  lines.push("");
  lines.push(`- Gateway reachable: ${snapshot.gateway.reachable ? "yes" : "no"}`);
  if (snapshot.gateway.runtimeVersion) lines.push(`- OpenClaw version: ${snapshot.gateway.runtimeVersion}`);
  if (snapshot.gateway.nodeVersion) lines.push(`- Gateway Node version: ${snapshot.gateway.nodeVersion}`);
  for (const vital of snapshot.vitals) {
    lines.push(`- ${vital.label}: ${vital.value}${vital.detail ? ` (${vital.detail})` : ""}`);
  }
  lines.push("");

  // ── Findings ──
  const actionable = snapshot.findings.filter((f) => !f.informational);
  const informational = snapshot.findings.filter((f) => f.informational);

  const renderFinding = (f: (typeof snapshot.findings)[number], index: number) => {
    lines.push(`### ${index}. ${redact(f.title)}`);
    lines.push("");
    lines.push(
      `*${f.severity} · ${f.family} · ${f.checkId} · ${
        f.confidence === "structured"
          ? "from machine-readable output"
          : f.confidence === "parsed"
            ? "read from the CLI's text output"
            : "derived from live measurements"
      }*`,
    );
    lines.push("");
    if (f.explanation) lines.push(redact(f.explanation));
    if (f.impact) {
      lines.push("");
      lines.push(`**If nothing is done:** ${redact(f.impact)}`);
    }
    if (f.causedBy) {
      lines.push("");
      lines.push(`**Caused by:** ${f.causedBy} — fixing that resolves this too.`);
    }
    if (f.fix) {
      lines.push("");
      lines.push(
        `**Available repair (${f.fix.safety}):** ${f.fix.label} — ${redact(f.fix.whatItDoes)}`,
      );
      if (f.fix.blocked) lines.push(`  - Currently blocked: ${redact(f.fix.blocked.reason)}`);
      for (const effect of f.fix.sideEffects) lines.push(`  - ${redact(effect)}`);
      lines.push(`  - Command: \`${redact(f.fix.command)}\``);
    }
    if (f.guide.length) {
      lines.push("");
      lines.push("**Steps:**");
      for (const [i, step] of f.guide.entries()) {
        lines.push(`  ${i + 1}. ${redact(step.title)} — ${redact(step.detail)}`);
        if (step.command) lines.push(`     \`${redact(step.command)}\``);
        if (step.verify) lines.push(`     Check: ${redact(step.verify)}`);
      }
    }
    if (f.evidence.length) {
      lines.push("");
      lines.push("<details><summary>Raw output</summary>");
      lines.push("");
      lines.push("```");
      for (const evidence of f.evidence) lines.push(redact(evidence));
      lines.push("```");
      lines.push("");
      lines.push("</details>");
    }
    lines.push("");
  };

  if (actionable.length) {
    lines.push("## Problems");
    lines.push("");
    actionable.forEach((f, i) => renderFinding(f, i + 1));
  } else if (health.state !== "never-checked") {
    lines.push("## Problems");
    lines.push("");
    lines.push("None found by the checks that ran.");
    lines.push("");
  }

  if (snapshot.prevention.length) {
    lines.push("## Worth knowing before it breaks");
    lines.push("");
    snapshot.prevention.forEach((f, i) => renderFinding(f, i + 1));
  }

  if (informational.length) {
    lines.push("## For information only");
    lines.push("");
    for (const f of informational) {
      lines.push(`- **${redact(f.title)}** — ${redact(f.explanation)}`);
    }
    lines.push("");
  }

  if (health.deductions.length) {
    lines.push("## How the score was calculated");
    lines.push("");
    lines.push("Starting from 100:");
    for (const d of health.deductions) lines.push(`- −${d.points} ${redact(d.reason)}`);
    lines.push("");
  }

  if (options.includeTranscript && options.transcript) {
    lines.push("## Full command output");
    lines.push("");
    lines.push("```");
    lines.push(redact(options.transcript));
    lines.push("```");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "Credentials, tokens and this machine's home directory have been removed from this report.",
  );

  return lines.join("\n");
}
