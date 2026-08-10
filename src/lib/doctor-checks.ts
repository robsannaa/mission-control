/**
 * Anchored parser for the legacy (human-readable) doctor pass.
 *
 * ## Why this file was rewritten
 *
 * It used to hold 26 regexes matched line-by-line against ANSI/box-drawing
 * output, plus a keyword fallback. Measured against the real run on this
 * machine it produced 9 "issues": 6 were fragments of wrapped sentences, 1 was
 * mis-severitied to `error`, and **none** of the machine's actual problems came
 * out intact. Keyword matching on wrapped prose cannot work — the line
 * `and keep running as-is: 'morning-briefing', ...` contains "running" and
 * nothing else, so it becomes a finding titled after half a sentence.
 *
 * ## What replaces it
 *
 * The legacy output is not free text. It is a sequence of titled boxes:
 *
 *     ◇  State integrity ──────────────╮
 *     │                                │
 *     │  - 1/5 recent sessions are ... │
 *     │    Verify sessions in store... │
 *     │                                │
 *     ├────────────────────────────────╯
 *
 * So we parse *structure*: find the box, take its title, unwrap its bullets
 * back into whole items. That yields a small set of `(section, item)` pairs
 * which `doctor-knowledge.ts` matches against curated signatures. Anything
 * unrecognised still surfaces — as a lower-confidence finding, never dropped —
 * because a doctor page that hides what it does not understand is worse than
 * one that admits it.
 *
 * ## Why this pass exists at all
 *
 * `--lint` does not implement every registered check. `state-integrity`,
 * `gateway-daemon`, `disk-space`, `session-transcripts`, `skills-readiness`,
 * `memory-search`, `command-owner` and `legacy-cron-store` all return `[]` from
 * lint while this pass reports real problems for several of them — including
 * the unsupported system Node and the 128 orphan transcripts. Lint silence on
 * those is "not checked", never "healthy".
 *
 * ⚠️ The legacy pass is **not read-only**: `doctor --non-interactive` applies
 * safe migrations and state moves. Callers must not present it as a scan.
 */

/** CSI escape sequences. NO_COLOR/TERM=dumb suppress most, never all. */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** `◇  Title ─────╮` */
const SECTION_HEADER_RE = /^\s*◇\s+(.+?)\s*[─—-]{3,}\s*╮\s*$/;
/** `├─────╯` */
const SECTION_FOOTER_RE = /^\s*├[─—-]+╯\s*$/;
/** `│  content   │` — the trailing bar is optional on very long lines. */
const SECTION_BODY_RE = /^\s*│(.*?)\s*│?\s*$/;

export type LegacyItem = {
  /** Box title, verbatim: "State integrity", "Gateway runtime", … */
  section: string;
  /** The item unwrapped into one line, whitespace-normalised. */
  text: string;
  /** The item's dedented source lines, for evidence. */
  lines: string[];
  /** True when the item was a `- ` bullet rather than a leading paragraph. */
  bullet: boolean;
  /** 0-based index of the box within the output, so repeats stay distinguishable. */
  sectionIndex: number;
};

export type LegacyParse = {
  items: LegacyItem[];
  /** Distinct box titles, in first-seen order. */
  sections: string[];
  /**
   * `Left … in place because …` lines from the `Doctor notices` boxes. Each one
   * means doctor *declined* a repair, so the corresponding fix button must be
   * suppressed rather than offered and silently ignored.
   */
  blockedRepairs: { what: string; reason: string }[];
  /** True when doctor printed its "Run `openclaw doctor --fix`" tail. */
  fixAvailable: boolean;
  /** True when the run reached `Doctor complete.` rather than dying midway. */
  complete: boolean;
};

function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, "");
}

/**
 * Remove the common left margin from a box body so bullet nesting becomes
 * meaningful. Boxes are padded to their own width, so the margin is whatever
 * the narrowest content line uses (2 in every observed case, but not assumed).
 */
function dedent(lines: string[]): string[] {
  let margin = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    margin = Math.min(margin, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(margin) || margin === 0) return lines;
  return lines.map((line) => (line.trim() ? line.slice(margin) : ""));
}

/**
 * Reassemble wrapped lines into whole items.
 *
 * Two continuation shapes exist in the real output and they differ:
 *   - a `- ` bullet wraps onto *indented* lines;
 *   - a leading paragraph wraps onto lines at column 0.
 * So an unindented line continues a paragraph but starts a new item after a
 * bullet. Getting this wrong is exactly how the old classifier turned one
 * sentence into three findings.
 */
function splitItems(body: string[]): { text: string; lines: string[]; bullet: boolean }[] {
  const items: { text: string; lines: string[]; bullet: boolean }[] = [];
  let current: { parts: string[]; lines: string[]; bullet: boolean } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) items.push({ text, lines: current.lines, bullet: current.bullet });
    current = null;
  };

  for (const line of body) {
    if (!line.trim()) {
      // A blank line inside a box is padding, not a separator — the boxes open
      // and close with one. Keep the current item open.
      continue;
    }
    const indented = /^\s/.test(line);
    const bulletMatch = /^-\s+(.*)$/.exec(line);

    if (bulletMatch) {
      flush();
      current = { parts: [bulletMatch[1]], lines: [line], bullet: true };
      continue;
    }
    if (!current) {
      current = { parts: [line.trim()], lines: [line], bullet: false };
      continue;
    }
    if (indented || !current.bullet) {
      current.parts.push(line.trim());
      current.lines.push(line);
      continue;
    }
    flush();
    current = { parts: [line.trim()], lines: [line], bullet: false };
  }
  flush();
  return items;
}

/** Parse a full legacy doctor transcript into titled sections and items. */
export function parseLegacyDoctorOutput(raw: string): LegacyParse {
  const lines = raw.split(/\r?\n/).map(stripAnsi);

  const items: LegacyItem[] = [];
  const sections: string[] = [];
  const blockedRepairs: { what: string; reason: string }[] = [];
  let fixAvailable = false;
  let complete = false;

  let sectionIndex = -1;
  let openTitle: string | null = null;
  let openBody: string[] = [];

  const closeSection = () => {
    if (openTitle === null) return;
    const title = openTitle;
    for (const item of splitItems(dedent(openBody))) {
      items.push({ section: title, sectionIndex, ...item });
    }
    openTitle = null;
    openBody = [];
  };

  for (const line of lines) {
    const header = SECTION_HEADER_RE.exec(line);
    if (header) {
      closeSection();
      sectionIndex++;
      openTitle = header[1].trim();
      if (!sections.includes(openTitle)) sections.push(openTitle);
      continue;
    }
    if (openTitle !== null) {
      if (SECTION_FOOTER_RE.test(line)) {
        closeSection();
        continue;
      }
      const body = SECTION_BODY_RE.exec(line);
      // `│` alone is the spacer between boxes; inside a box it is padding.
      if (body) openBody.push(body[1].replace(/\s+$/, ""));
      continue;
    }
    // Outside any box: doctor's own tail lines.
    if (/Run\s+"?`?openclaw doctor --fix`?"?/i.test(line)) fixAvailable = true;
    if (/Doctor complete\./i.test(line)) complete = true;
  }
  closeSection();

  // Deduplicate: doctor prints the notices box up to three times per run, and
  // repeats it verbatim on stdout under a `[state-migrations]` prefix.
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = `${item.section}\u0000${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Blocked repairs are scanned across the *whole* transcript, not only inside
  // boxes. Several commands (`security audit`, `secrets audit`) print the same
  // notice to stderr as bare `[state-migrations]` lines with no box around
  // them, and that is the only place the notice appears during a read-only
  // pass. Missing it there would mean offering a fix button for a repair
  // OpenClaw has already refused to perform.
  const seenBlocked = new Set<string>();
  // Unwrapped box items first (the notice inside a `Doctor notices` box is
  // wrapped across lines and only readable once reassembled), then raw lines.
  for (const candidate of [...unique.map((i) => i.text), ...lines]) {
    const blocked = /Left\s+(.+?)\s+in place because\s+(.+?)\.?\s*$/i.exec(candidate.trim());
    if (!blocked) continue;
    const key = `${blocked[1]}|${blocked[2]}`;
    if (seenBlocked.has(key)) continue;
    seenBlocked.add(key);
    blockedRepairs.push({ what: blocked[1].trim(), reason: blocked[2].trim() });
  }

  return { items: unique, sections, blockedRepairs, fixAvailable, complete };
}

// ── Compatibility shim ──────────────────────────────────────────────────────
//
// `doctor-report.ts` (the config editor's post-save check) uses a text
// classifier only as its third fallback, for the case where `--lint --json`
// produced unparseable output. That path still needs a `DoctorIssue[]`, so the
// shape is preserved — but it is now backed by the section parser above rather
// than by keyword guessing, and it no longer invents categories or fix modes it
// cannot honour.

export type DoctorIssue = {
  severity: "error" | "warning" | "info";
  checkId: string;
  rawText: string;
  title: string;
  detail: string;
  fixable: boolean;
  fixMode?: "repair" | "repair-force" | "generate-token" | "restart";
  category: string;
};

/**
 * Severity of a whole box, by title.
 *
 * Assigned per *section* rather than per line, because the section header is
 * the only part of the output with stable wording. Sections not listed here are
 * treated as warnings when doctor offers a fix and info otherwise — never as
 * errors, since guessing "error" from prose was how the old classifier
 * escalated an informational cron notice into a red banner.
 */
const SECTION_SEVERITY: Record<string, "error" | "warning" | "info"> = {
  "gateway runtime": "warning",
  "gateway service config": "warning",
  "state integrity": "warning",
  "legacy state detected": "warning",
  security: "warning",
  cron: "info",
  "session locks": "info",
  "doctor notices": "info",
  "doctor info": "info",
  "skills status": "info",
  plugins: "info",
};

function firstSentence(text: string): string {
  const cut = /^(.{0,120}?[.!?])(\s|$)/.exec(text);
  const candidate = (cut ? cut[1] : text).trim();
  return candidate.length > 120 ? `${candidate.slice(0, 117)}…` : candidate;
}

/**
 * Legacy entry point kept for `doctor-report.ts`.
 *
 * Prefer `parseLegacyDoctorOutput` plus `doctor-knowledge.ts` for anything new:
 * this shim cannot express root causes, previews, or confidence.
 */
export function classifyDoctorOutput(lines: string[]): DoctorIssue[] {
  const parsed = parseLegacyDoctorOutput(lines.join("\n"));
  const issues: DoctorIssue[] = [];

  for (const item of parsed.items) {
    const key = item.section.toLowerCase();
    const severity = SECTION_SEVERITY[key] ?? "info";
    issues.push({
      severity,
      checkId: `legacy/${key.replace(/\s+/g, "-")}`,
      rawText: item.text,
      title: firstSentence(item.text),
      detail: item.text,
      fixable: false,
      category: item.section,
    });
  }

  const rank = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
