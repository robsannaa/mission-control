/**
 * Turns machine output into something a person can act on.
 *
 * Every entry here is anchored to output observed on a real OpenClaw 2026.7.1-2
 * install. Nothing is speculative: if a check has never been seen to fire, it
 * falls through to the generic builder, which repeats the CLI's own wording and
 * marks the finding as un-curated rather than inventing an explanation for it.
 *
 * The three things every finding must answer, from the design bar:
 *   1. What is wrong          → `title`
 *   2. Why it matters to me   → `explanation`
 *   3. What happens if I press → `fix.whatItDoes` + `fix.sideEffects`
 *
 * Root causes are recorded as real relationships, not a visual grouping:
 *   - the version-manager Node in the service definition exists *because* the
 *     system Node is unsupported (the daemon fell back to it);
 *   - `config.insecure_or_dangerous_flags` and `gateway.control_ui.insecure_auth`
 *     are two reports of one flag, so one is the cause of the other.
 * Anything without a demonstrable causal link stays flat. Inventing a hierarchy
 * would be as dishonest as inventing a score.
 */

import type {
  DoctorFinding,
  DoctorFix,
  DoctorGuideStep,
  DoctorSeverity,
  DoctorVital,
} from "./doctor-types";
import type { LintGroup } from "./doctor-lint";
import type { LegacyItem, LegacyParse } from "./doctor-checks";
import { FIX_PLANS, fixCommand, type FixPlan } from "./doctor-fix-catalog";
import { redact, redactAll } from "./doctor-redact";

// ── Fix descriptors ─────────────────────────────────────────────────────────

function describeFix(
  planId: string,
  options: { blocked?: string | null; alsoResolves?: string[] } = {},
): DoctorFix | null {
  const plan: FixPlan | undefined = FIX_PLANS[planId];
  if (!plan) return null;
  return {
    id: plan.id,
    label: plan.label,
    safety: plan.safety,
    whatItDoes: plan.whatItDoes,
    sideEffects: plan.sideEffects,
    requiresRestart: plan.requiresRestart,
    requiresConfirmation: plan.safety !== "safe",
    previewAvailable: plan.previewKind !== "none",
    blocked: options.blocked ? { reason: options.blocked } : null,
    command: fixCommand(plan),
    alsoResolves: options.alsoResolves ?? [],
  };
}

function baseFinding(partial: Partial<DoctorFinding> & Pick<DoctorFinding, "id">): DoctorFinding {
  return {
    checkId: partial.id,
    source: "lint",
    confidence: "structured",
    severity: "warning",
    family: "Other",
    title: partial.id,
    explanation: "",
    impact: "",
    evidence: [],
    paths: [],
    causedBy: null,
    causes: [],
    informational: false,
    fix: null,
    guide: [],
    docs: null,
    mergedFrom: [],
    ...partial,
  };
}

// ── Lint findings ───────────────────────────────────────────────────────────

/** Short family label from a `core/doctor/<name>` id. */
function familyOf(checkId: string): string {
  const tail = checkId.split("/").pop() ?? checkId;
  return tail
    .split("-")
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

type LintBuilder = (group: LintGroup) => Partial<DoctorFinding>;

/**
 * Curated wording per check id. Only checks observed firing on a real install
 * appear here — see the module header on why nothing else is guessed.
 */
const LINT_KNOWLEDGE: Record<string, LintBuilder> = {
  "core/doctor/configured-plugin-installs": (group) => ({
    family: "Add-ons",
    title: `The ${group.targets.join(", ") || "add-on"} add-on is running an older build than OpenClaw itself`,
    explanation:
      "OpenClaw was updated but this add-on was not, so the two no longer match. Mismatched versions are the usual cause of an add-on that fails to start, hangs, or behaves oddly for no visible reason.",
    impact:
      "Left alone, the add-on may stop working after the next update, usually without a clear error.",
    fix: describeFix("doctor-fix"),
    guide: [],
  }),

  "core/doctor/legacy-state": (group) => ({
    family: "Stored data",
    title: "Some settings still live in a file newer versions no longer read",
    explanation:
      // redact() collapses the operator's home directory to `~`, matching how
      // every other path in the UI reads. Without it this one line prints an
      // absolute /Users/<name>/ path on screen.
      `OpenClaw moved this information into its shared database. The old file (${group.paths[0] ? redact(group.paths[0]) : "in your OpenClaw folder"}) is still there, and until it is moved across, the two can disagree about what is installed.`,
    impact:
      "Nothing is broken today. It becomes a problem when the two copies drift apart and an add-on appears installed in one place and missing in the other.",
    fix: describeFix("doctor-fix"),
  }),

  "core/doctor/security": () => ({
    family: "Secrets",
    severity: "warning" as DoctorSeverity,
    title: "Passwords and keys are stored as plain text in your settings file",
    explanation:
      "Your settings file holds several credentials in readable form. Anything that can open that file can read them — including tools your assistant runs on your behalf, which is the realistic risk here rather than someone breaking into the machine.",
    impact:
      "A single leaked settings file — a backup, a support bundle, a shared screenshot — hands over every credential in it at once.",
    // Migration needs an interactive chooser (which keychain, which provider),
    // so a one-click button would be a dead end. Walk it instead.
    guide: [
      {
        title: "Choose where the secrets should live",
        detail:
          "OpenClaw can keep credentials in your system keychain or read them from environment variables instead of storing them in the settings file.",
        command: "openclaw secrets configure",
        verify: "The chooser lists your credentials and asks where to put each one.",
      },
      {
        title: "Apply the move",
        detail:
          "This rewrites the settings file so each credential is a reference instead of the value itself. The values move to the store you picked.",
        command: "openclaw secrets apply",
        verify: "Your settings file no longer contains the values.",
      },
      {
        title: "Confirm nothing is left behind",
        detail: "Re-checks every file OpenClaw knows about for readable credentials.",
        command: "openclaw secrets audit --check",
        verify: "Reports no plaintext findings.",
      },
    ],
  }),
};

export function buildLintFindings(groups: readonly LintGroup[]): DoctorFinding[] {
  return groups.map((group) => {
    const id = `lint:${group.checkId}`;
    const curated = LINT_KNOWLEDGE[group.checkId]?.(group) ?? {};
    const messages = group.rows.map((r) => r.message);

    return baseFinding({
      id,
      checkId: group.checkId,
      source: "lint",
      confidence: "structured",
      severity: group.severity,
      family: familyOf(group.checkId),
      // Fall back to the CLI's own first line rather than inventing prose for a
      // check nobody has curated. Honest, if terse.
      title: messages[0] ?? group.checkId,
      explanation: messages.slice(1).join(" "),
      impact: "",
      evidence: redactAll(messages),
      paths: redactAll(group.paths),
      // The CLI's own hint is the only fix wording we have for un-curated
      // checks; presenting it as a button we cannot honour would be worse.
      guide: !curated.fix && !curated.guide && group.fixHint
        ? [{ title: "What OpenClaw suggests", detail: redact(group.fixHint) }]
        : [],
      ...curated,
    });
  });
}

// ── Legacy findings ─────────────────────────────────────────────────────────

type LegacyRule = {
  /** Box title, lowercased. */
  section: string;
  /** Signature within the item text. Anchored on wording the CLI controls. */
  match: RegExp;
  build: (m: RegExpExecArray, item: LegacyItem) => Partial<DoctorFinding> & { id: string };
};

const GB = 1024 ** 3;

/** Rules in priority order; the first match for an item wins. */
const LEGACY_RULES: LegacyRule[] = [
  {
    section: "gateway runtime",
    match: /System Node (\S+) at (\S+) is outside the supported range\.\s*Using (\S+) for the daemon/i,
    build: (m) => ({
      id: "legacy:node-unsupported",
      checkId: "core/doctor/gateway-runtime",
      family: "Runtime",
      severity: "warning",
      title: `This machine's main Node version (${m[1]}) is one OpenClaw does not support`,
      explanation:
        `The Node runtime at ${m[2]} is outside the range OpenClaw is tested against. OpenClaw is working around it right now by borrowing an older Node it found on this machine (${m[3].replace(/^.*\/node\/(v[\d.]+)\/.*$/, "$1") || "another version"}), which is why things still work.`,
      impact:
        "The workaround depends on that other version staying exactly where it is. If it is removed or upgraded, OpenClaw stops starting — usually noticed as the service simply not coming back after a reboot.",
      guide: [
        {
          title: "Install a supported Node version",
          detail:
            "Node 24.15 or newer, or 22.22.3 or newer. Download it from nodejs.org, or install it with Homebrew if you use that.",
          command: "brew install node@24",
          verify: "Running `node -v` in a terminal reports a supported version.",
        },
        {
          title: "Point the background service at it",
          detail:
            "Rewrites the service entry so OpenClaw starts with the newly installed version instead of the borrowed one.",
          fixId: "gateway-service-reinstall",
          command: "openclaw gateway install --force",
          verify: "This finding disappears from the next check.",
        },
      ],
    }),
  },
  {
    section: "gateway service config",
    match: /Gateway service uses Node from a version manager.*?\((\S+)\)/i,
    build: (m) => ({
      id: "legacy:service-node-version-manager",
      checkId: "core/doctor/gateway-services",
      family: "Background service",
      severity: "warning",
      title: "The background service starts OpenClaw using a Node installed by a version manager",
      explanation:
        `The service entry points at ${m[1]}. Version managers move and delete those folders when you install or clean up Node versions — the path is not stable the way a system install is.`,
      impact:
        "If that version is removed or upgraded, OpenClaw stops starting at login and does not come back after a reboot, with no message anywhere obvious.",
      // Caused by the unsupported system Node: the daemon fell back to this
      // path *because* it could not use the system one. Fixing the cause and
      // re-running the installer resolves both.
      causedBy: "legacy:node-unsupported",
      guide: [
        {
          title: "Install a supported system-wide Node first",
          detail:
            "Rewriting the service now would just re-record the same borrowed path. Install Node 24.15+ or 22.22.3+ from nodejs.org or Homebrew.",
          verify: "`node -v` reports a supported version.",
        },
        {
          title: "Rewrite the service entry",
          detail: "Regenerates the startup entry against the newly installed Node.",
          fixId: "gateway-service-reinstall",
          command: "openclaw gateway install --force",
          verify: "This finding disappears from the next check.",
        },
      ],
    }),
  },
  {
    section: "state integrity",
    match: /(\d+)\s*\/\s*(\d+) recent sessions are missing transcripts/i,
    build: (m) => ({
      id: "legacy:sessions-missing-transcripts",
      checkId: "core/doctor/state-integrity",
      family: "Conversations",
      severity: "warning",
      title: `${m[1]} of your ${m[2]} most recent conversations have lost their transcript files`,
      explanation:
        "Your conversation list still has entries for them, but the files holding what was actually said are gone. Opening one shows an empty conversation.",
      impact:
        "The content is already unrecoverable. Leaving the entries in place means the list keeps offering conversations that cannot be opened.",
      fix: describeFix("sessions-prune-missing"),
    }),
  },
  {
    section: "state integrity",
    match: /Found (\d+) orphan transcript files in (\S+)/i,
    build: (m) => ({
      id: "legacy:orphan-transcripts",
      checkId: "core/doctor/state-integrity",
      family: "Conversations",
      severity: "info",
      title: `${m[1]} leftover conversation files are taking up space`,
      explanation:
        // The capture swallows the sentence's full stop, so trim it before the
        // path is joined to more prose — and redact the home directory.
        `These files in ${redact(m[2].replace(/\.$/, ""))} are not referenced by any conversation you can open. They are usually left behind by interrupted runs.`,
      impact:
        "They only cost disk space. OpenClaw can archive them by renaming rather than deleting, so nothing is lost if you change your mind.",
      fix: describeFix("doctor-fix"),
    }),
  },
  {
    section: "session locks",
    match: /Found (\d+) session lock files?/i,
    build: (m, item) => ({
      id: "legacy:session-locks",
      checkId: "core/doctor/session-locks",
      family: "Conversations",
      // Locks held by a live process are normal bookkeeping, not a problem.
      // Only a stale lock (owner gone) blocks anything.
      severity: "info",
      informational: !/stale=yes/i.test(item.text),
      title: `${m[1]} conversation${Number(m[1]) === 1 ? " is" : "s are"} currently open`,
      explanation:
        "OpenClaw marks a conversation while it is writing to it, so two processes cannot corrupt the same file. These markers are held by a running process, which is exactly what should happen.",
      impact: "",
    }),
  },
  {
    section: "cron",
    match: /(\d+) cron jobs? (?:is|are) still marked in-flight/i,
    build: (m) => ({
      id: "legacy:cron-in-flight",
      checkId: "core/doctor/legacy-cron-store",
      family: "Scheduled jobs",
      severity: "info",
      title: `${m[1]} scheduled job is still marked as running`,
      explanation:
        "A job was interrupted mid-run — usually because the service restarted — and its 'running' marker was never cleared, so the job list still shows it as active.",
      impact:
        "It clears itself: the next time the service starts it marks interrupted runs as finished. Nothing needs doing unless it persists across restarts.",
      informational: true,
    }),
  },
  {
    section: "cron",
    match: /(\d+) isolated cron jobs drive shell\/process tools from the agent prompt[^:]*:\s*(.+?)\.\s*$/i,
    build: (m) => ({
      id: "legacy:cron-shell-jobs",
      checkId: "core/doctor/legacy-cron-store",
      family: "Scheduled jobs",
      severity: "info",
      informational: true,
      title: `${m[1]} scheduled jobs let the assistant run shell commands on a timer`,
      explanation:
        `These jobs — ${m[2].replace(/`/g, "")} — ask the assistant to do something that involves running commands on this machine, on a schedule. That is a supported setup and it is presumably what you intended.`,
      impact:
        "Nothing to fix. It is listed so the capability is visible rather than invisible; there is no repair for it and none is needed.",
    }),
  },
  {
    section: "plugins",
    match: /Errors:\s*([1-9]\d*)/i,
    build: (m) => ({
      id: "legacy:plugin-errors",
      checkId: "core/doctor/plugin-registry",
      family: "Add-ons",
      severity: "error",
      title: `${m[1]} add-on${Number(m[1]) === 1 ? "" : "s"} failed to load`,
      explanation:
        "OpenClaw tried to start these add-ons and they errored out. Anything they provide — a chat channel, a tool, a model provider — is unavailable.",
      impact: "Features you may not realise you are missing simply will not appear.",
    }),
  },
];

/**
 * Items we deliberately do not turn into findings, with the reason. Suppression
 * is enumerated rather than implicit so nothing disappears silently.
 */
const LEGACY_SUPPRESSED: { section: string; match: RegExp; reason: string }[] = [
  {
    section: "doctor notices",
    match: /^Left .+ in place because/i,
    reason: "Recorded as a blocked-repair marker on the finding it belongs to.",
  },
  {
    section: "security",
    match: /^Run: openclaw security audit/i,
    reason: "We run the security audit ourselves and show its findings directly.",
  },
  {
    section: "security",
    match: /plaintext secret-bearing config fields/i,
    reason: "Same problem as the structured security check; merged into that finding.",
  },
  {
    section: "gateway service config",
    match: /^Run `openclaw gateway install --force`/i,
    reason: "Advice, not a finding. Attached to the service-node finding as a step.",
  },
  {
    section: "legacy state detected",
    match: /^Plugin install index:/i,
    reason: "Same problem as the structured legacy-state check; merged into that finding.",
  },
  {
    section: "session locks",
    match: /\.lock\s+pid=/i,
    reason: "Per-lock detail; folded into the lock-count finding as evidence.",
  },
  {
    section: "skills status",
    match: /^Eligible:/i,
    reason: "A healthy rollup, shown as a vital rather than dressed up as a finding.",
  },
  {
    section: "plugins",
    match: /^Loaded:/i,
    reason: "A healthy rollup, shown as a vital rather than dressed up as a finding.",
  },
];

/** Rollup numbers worth showing, quietly, without pretending they are problems. */
function extractVitals(parse: LegacyParse): DoctorVital[] {
  const vitals: DoctorVital[] = [];
  for (const item of parse.items) {
    const section = item.section.toLowerCase();
    if (section === "skills status") {
      const eligible = /Eligible:\s*(\d+)/i.exec(item.text);
      const missing = /Missing requirements:\s*(\d+)/i.exec(item.text);
      const blocked = /Blocked by allowlist:\s*(\d+)/i.exec(item.text);
      if (eligible) {
        vitals.push({
          id: "skills",
          label: "Skills ready to use",
          value: eligible[1],
          detail:
            missing && blocked
              ? `${missing[1]} missing a requirement, ${blocked[1]} blocked`
              : undefined,
          status: "ok",
          source: "legacy",
        });
      }
    }
    if (section === "plugins") {
      const loaded = /Loaded:\s*(\d+)/i.exec(item.text);
      const disabled = /Disabled:\s*(\d+)/i.exec(item.text);
      const errors = /Errors:\s*(\d+)/i.exec(item.text);
      if (loaded) {
        vitals.push({
          id: "plugins",
          label: "Add-ons loaded",
          value: loaded[1],
          detail: [
            disabled ? `${disabled[1]} switched off` : null,
            errors ? `${errors[1]} failed` : null,
          ]
            .filter(Boolean)
            .join(", "),
          status: "ok",
          source: "legacy",
        });
      }
    }
  }
  return vitals;
}

export type LegacyBuild = {
  findings: DoctorFinding[];
  vitals: DoctorVital[];
  /** Items that matched no rule and no suppression. Surfaced, never dropped. */
  uncurated: number;
};

export function buildLegacyFindings(parse: LegacyParse): LegacyBuild {
  const findings: DoctorFinding[] = [];
  const byId = new Map<string, DoctorFinding>();
  /**
   * The last finding produced by each box.
   *
   * A box is one topic. The `Cron` box that reports isolated shell jobs opens
   * with the headline and then explains itself in two bullets; the `Doctor
   * info` box does the same across four. Emitting one finding per bullet turned
   * "there is no fix for this and none is needed" into a standalone *warning* —
   * the exact fragmentation the old classifier was replaced for. So an item
   * that matches no rule attaches to whatever its box already produced, and
   * only starts a finding of its own if the box has produced nothing.
   */
  const lastInSection = new Map<number, DoctorFinding>();
  let uncurated = 0;

  const lockDetail = parse.items
    .filter((i) => i.section.toLowerCase() === "session locks" && /\.lock\s+pid=/i.test(i.text))
    .map((i) => i.text);

  for (const item of parse.items) {
    const section = item.section.toLowerCase();

    if (LEGACY_SUPPRESSED.some((s) => s.section === section && s.match.test(item.text))) continue;

    let matched = false;
    for (const rule of LEGACY_RULES) {
      if (rule.section !== section) continue;
      const m = rule.match.exec(item.text);
      if (!m) continue;
      matched = true;

      const built = rule.build(m, item);
      const existing = byId.get(built.id);
      if (existing) {
        existing.evidence.push(redact(item.text));
        break;
      }
      const finding = baseFinding({
        source: "legacy",
        // Anchored on a section header and a curated signature, so the finding
        // is real — but the wording is not a contract, hence `parsed`.
        confidence: "parsed",
        evidence: redactAll(
          built.id === "legacy:session-locks" ? [item.text, ...lockDetail] : [item.text],
        ),
        ...built,
      });
      // A repair doctor has already declined must not be offered as a button.
      const blocked = blockedReasonFor(parse, finding);
      if (blocked && finding.fix) finding.fix = { ...finding.fix, blocked: { reason: blocked } };
      findings.push(finding);
      byId.set(finding.id, finding);
      lastInSection.set(item.sectionIndex, finding);
      break;
    }

    if (matched) continue;

    const owner = lastInSection.get(item.sectionIndex);
    if (owner) {
      owner.evidence.push(redact(item.text));
      continue;
    }

    // Doctor info boxes are, by the CLI's own framing, informational.
    const informational = section === "doctor info" || section === "doctor notices";
    uncurated++;
    const fallback = baseFinding({
      id: `legacy:${section.replace(/\s+/g, "-")}:${hash(item.text)}`,
      checkId: `legacy/${section.replace(/\s+/g, "-")}`,
      source: "legacy",
      // No curated signature matched. The text is real, our reading of it is
      // not verified — say so rather than dressing it up.
      confidence: "parsed",
      // Severity is a *claim*, and we have not verified this one. Defaulting to
      // "warning" charged the score for `--deep`'s tool-result-cap and
      // connected-clients sections, both of which are informational by the
      // CLI's own framing. An unrecognised item is shown in full and left out
      // of the arithmetic rather than assigned an importance nobody checked.
      severity: "info",
      informational,
      family: item.section,
      title: firstSentence(redact(item.text)),
      explanation: `${redact(item.text)}\n\nOpenClaw reported this under “${item.section}”. Mission Control has no plain-language explanation for it yet, so it is shown exactly as OpenClaw wrote it and is not counted towards the score.`,
      impact: "",
      evidence: [redact(item.text)],
    });
    findings.push(fallback);
    lastInSection.set(item.sectionIndex, fallback);
  }

  return { findings, vitals: extractVitals(parse), uncurated };
}

function blockedReasonFor(parse: LegacyParse, finding: DoctorFinding): string | null {
  return blockedReasonFrom(parse.blockedRepairs, finding);
}

/**
 * Match a `Left … in place because …` notice to the findings it silences.
 *
 * Blocked-repair detection is mandatory: offering a button for a repair
 * OpenClaw has already refused to perform produces the worst possible user
 * experience — the command runs, reports success, and nothing changes. The
 * subject nouns doctor uses are few and stable, so matching is explicit rather
 * than fuzzy.
 */
export function blockedReasonFrom(
  blockedRepairs: readonly { what: string; reason: string }[],
  finding: DoctorFinding,
): string | null {
  const haystack =
    `${finding.checkId} ${finding.title} ${finding.explanation} ${finding.evidence.join(" ")}`.toLowerCase();
  for (const blocked of blockedRepairs) {
    const subject = blocked.what.toLowerCase();
    if (
      subject.includes("plugin install index") &&
      /plugin|add-on|legacy-state|installs\.json/.test(haystack)
    ) {
      return `OpenClaw tried this already and left things as they are: ${blocked.reason}.`;
    }
  }
  return null;
}

/**
 * Stamp blocked-repair notices onto every finding whose fix they suppress.
 *
 * Run over the *whole* snapshot rather than only the legacy pass, because the
 * notice also appears on stderr during the read-only pass — so the quick check
 * knows a repair is blocked even though it never ran the full one.
 */
export function applyBlockedRepairs(
  findings: DoctorFinding[],
  blockedRepairs: readonly { what: string; reason: string }[],
): DoctorFinding[] {
  if (!blockedRepairs.length) return findings;
  for (const finding of findings) {
    if (!finding.fix || finding.fix.blocked) continue;
    const reason = blockedReasonFrom(blockedRepairs, finding);
    if (reason) finding.fix = { ...finding.fix, blocked: { reason } };
  }
  return findings;
}

function firstSentence(text: string): string {
  const cut = /^(.{0,130}?[.!?])(\s|$)/.exec(text);
  const candidate = (cut ? cut[1] : text).trim();
  return candidate.length > 130 ? `${candidate.slice(0, 127)}…` : candidate;
}

/**
 * Stable short hash so an un-curated item keeps its id across runs.
 *
 * Digits are normalised away first. Un-curated text is full of counts —
 * "130 leftover files", "context window 1,000,000" — and hashing them verbatim
 * mints a new id every time a number moves, which the history diff then reports
 * as one finding resolved and another appearing. The prose identifies the
 * finding; the numbers are its current value.
 */
function hash(text: string): string {
  const normalised = text.replace(/[\d,]+/g, "#");
  let h = 2166136261;
  for (let i = 0; i < normalised.length; i++) {
    h ^= normalised.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ── security audit ──────────────────────────────────────────────────────────

export type SecurityAuditFinding = {
  checkId: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail?: string;
  remediation?: string;
};

export type SecurityAuditEnvelope = {
  ts?: number;
  summary?: { critical?: number; warn?: number; info?: number };
  findings?: SecurityAuditFinding[];
};

/** `security audit` uses `warn`, doctor uses `warning`. Normalise once, here. */
function normaliseSecuritySeverity(s: string): DoctorSeverity {
  if (s === "critical") return "error";
  if (s === "warn") return "warning";
  return "info";
}

const SECURITY_KNOWLEDGE: Record<
  string,
  {
    title: string;
    explanation: string;
    impact: string;
    fixId?: string;
    causedBy?: string;
    /**
     * Downgrade to informational, with the reason recorded on the finding.
     *
     * Used only where the audit's own severity contradicts its own detail: it
     * rates the missing trusted-proxy list a warning while stating the gateway
     * binds to loopback, where the setting has no effect. Charging the score
     * for something we then describe as "nothing needs doing" would make the
     * deduction list read as nonsense. The original severity is preserved in
     * `demotedFrom` so nothing is hidden.
     */
    demoteToInfo?: string;
  }
> = {
  "gateway.control_ui.insecure_auth": {
    title: "The built-in web interface is set to accept a relaxed sign-in",
    explanation:
      "A setting normally used for debugging is switched on. It loosens how the gateway's own web interface checks who you are.",
    impact:
      "On a machine only you can reach, the practical risk is low. On anything reachable from your network, it widens who can get in.",
    fixId: "disable-insecure-auth",
  },
  "config.insecure_or_dangerous_flags": {
    title: "A debugging setting is still switched on",
    explanation:
      "This is the same relaxed sign-in setting reported above, seen from a second check. Turning it off clears both.",
    impact: "Same as above — this row is a consequence, not a separate problem.",
    causedBy: "security:gateway.control_ui.insecure_auth",
    fixId: "disable-insecure-auth",
  },
  "gateway.trusted_proxies_missing": {
    title: "No reverse proxy is trusted, and none needs to be right now",
    explanation:
      "The gateway only listens on this machine, so it does not need to trust forwarded-address headers from a proxy. This is a reminder for if you ever put it behind one.",
    impact:
      "Nothing to do unless you expose the interface through a proxy. If you do, configure the trusted addresses first, or a caller could pretend to be local.",
    demoteToInfo:
      "OpenClaw rates this a warning. This gateway only listens on this machine, so the setting has no effect today — shown as information rather than counted against the score.",
  },
  "security.trust_model.multi_user_heuristic": {
    title: "More than one person may be able to reach this assistant",
    explanation:
      "Signals suggest this gateway is reachable by several people — a chat group is allow-listed, and the assistant can run commands and edit files without a sandbox. OpenClaw is built around one trusted operator, not mutually distrusting users sharing one gateway.",
    impact:
      "If everyone with access is you or people you trust with your machine, nothing is wrong. If not, they can effectively act as you.",
  },
  "plugins.installs_unpinned_npm_specs": {
    title: "Two add-ons will update themselves to whatever version is newest",
    explanation:
      "Their install records do not name an exact version, so a reinstall picks up whatever has been published since.",
    impact:
      "A bad release upstream lands on your machine without you choosing it. Pinning exact versions avoids the surprise.",
  },
  "gateway.http.session_key_override_enabled": {
    title: "API callers can pick which conversation they write to",
    explanation:
      "Requests to the HTTP API may name a session key, so anything holding an API credential can route into a chosen conversation.",
    impact:
      "Nothing to fix. It means API credentials should be treated as seriously as your own login.",
  },
  "summary.attack_surface": {
    title: "Summary of what is exposed",
    explanation: "A rollup of which capabilities are switched on. Reference, not a problem.",
    impact: "",
  },
};

export function buildSecurityFindings(
  envelope: SecurityAuditEnvelope | null,
): DoctorFinding[] {
  if (!envelope?.findings?.length) return [];

  return envelope.findings.map((row) => {
    const known = SECURITY_KNOWLEDGE[row.checkId];
    const reported = normaliseSecuritySeverity(row.severity);
    const severity = known?.demoteToInfo ? "info" : reported;
    const informational = severity === "info";
    return baseFinding({
      id: `security:${row.checkId}`,
      checkId: row.checkId,
      source: "security-audit",
      confidence: "structured",
      severity,
      informational,
      family: "Security",
      title: known?.title ?? row.title,
      explanation: known?.explanation ?? redact(row.detail ?? ""),
      impact: known?.impact ?? "",
      evidence: redactAll(
        [
          known?.demoteToInfo ? `Reported by OpenClaw as: ${reported}. ${known.demoteToInfo}` : null,
          row.title,
          row.detail,
          row.remediation,
        ].filter(Boolean) as string[],
      ),
      causedBy: known?.causedBy ?? null,
      fix: known?.fixId ? describeFix(known.fixId) : null,
      guide:
        !known?.fixId && row.remediation
          ? [{ title: "What OpenClaw suggests", detail: redact(row.remediation) }]
          : [],
    });
  });
}

// ── secrets audit ───────────────────────────────────────────────────────────

export type SecretsAuditEnvelope = {
  summary?: {
    plaintextCount?: number;
    unresolvedRefCount?: number;
    shadowedRefCount?: number;
    legacyResidueCount?: number;
  };
  findings?: { code: string; severity: string; file?: string; jsonPath?: string; message?: string }[];
};

/**
 * The secrets audit sees more than the doctor check does.
 *
 * `core/doctor/security` reports the three plaintext values in openclaw.json.
 * `secrets audit` finds seven, across four files — the extra four are in the
 * agent database, models.json and .env. Rather than showing two findings that
 * disagree about the size of the same problem, the wider result is folded into
 * the doctor finding as additional locations. Both sources are recorded in
 * `mergedFrom` so the report can show its working.
 */
export function mergeSecretsAudit(
  findings: DoctorFinding[],
  envelope: SecretsAuditEnvelope | null,
): DoctorFinding[] {
  if (!envelope?.findings?.length) return findings;

  const plaintext = envelope.findings.filter((f) => f.code === "PLAINTEXT_FOUND");
  if (!plaintext.length) return findings;

  const target = findings.find((f) => f.checkId === "core/doctor/security");
  const locations = plaintext.map((f) => `${redact(f.file ?? "")} → ${f.jsonPath ?? ""}`);
  const fileCount = new Set(plaintext.map((f) => f.file)).size;

  if (!target) {
    findings.push(
      baseFinding({
        id: "secrets:plaintext",
        checkId: "secrets/plaintext",
        source: "secrets-audit",
        confidence: "structured",
        severity: "warning",
        family: "Secrets",
        title: `${plaintext.length} passwords and keys are stored as plain text`,
        explanation: `Readable credentials were found across ${fileCount} file${fileCount === 1 ? "" : "s"} OpenClaw uses.`,
        impact:
          "Anything that can read those files — including tools your assistant runs — can read the credentials.",
        evidence: locations,
      }),
    );
    return findings;
  }

  target.mergedFrom = [...target.mergedFrom, "secrets-audit"];
  target.evidence = [...target.evidence, ...locations];
  target.explanation +=
    ` A wider scan finds ${plaintext.length} in total, across ${fileCount} files — not only your settings file.`;
  return findings;
}

// ── causal wiring ───────────────────────────────────────────────────────────

/**
 * Fill in the inverse of every `causedBy`, and drop links whose target is not
 * present in this run. A dangling cause would render as a chain the user cannot
 * follow, which is worse than a flat list.
 */
export function linkCauses(findings: DoctorFinding[]): DoctorFinding[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  for (const finding of findings) {
    if (!finding.causedBy) continue;
    const cause = byId.get(finding.causedBy);
    if (!cause) {
      finding.causedBy = null;
      continue;
    }
    if (!cause.causes.includes(finding.id)) cause.causes.push(finding.id);
  }
  return findings;
}

/**
 * Group findings that share a fix command, so the UI can say "this button also
 * clears these" and the preview can list every one of them.
 */
export function linkSharedFixes(findings: DoctorFinding[]): DoctorFinding[] {
  const byFix = new Map<string, DoctorFinding[]>();
  for (const finding of findings) {
    if (!finding.fix) continue;
    const list = byFix.get(finding.fix.id) ?? [];
    list.push(finding);
    byFix.set(finding.fix.id, list);
  }
  for (const [, group] of byFix) {
    if (group.length < 2) continue;
    for (const finding of group) {
      finding.fix = {
        ...finding.fix!,
        alsoResolves: group.filter((g) => g.id !== finding.id).map((g) => g.id),
      };
    }
  }
  return findings;
}

export const DISK_WARN_FREE_RATIO = 0.1;
export const DISK_CRITICAL_FREE_RATIO = 0.05;
export const GIGABYTE = GB;

export type { DoctorGuideStep };
