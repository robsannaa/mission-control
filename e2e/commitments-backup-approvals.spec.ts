import { expect, test } from "@playwright/test";
import { confidenceLabel, dueBucket, groupByDue, formatDue, type Commitment } from "../src/lib/commitments-types";
import { parseBackupOutput } from "../src/lib/backup-types";
import { deriveMode, allowlistFor, type ApprovalsSnapshot } from "../src/lib/exec-approvals-types";

test.describe("commitments-types", () => {
  test("confidence labels", () => {
    expect(confidenceLabel(0.9).label).toBe("High");
    expect(confidenceLabel(0.6).label).toBe("Medium");
    expect(confidenceLabel(0.2).label).toBe("Low");
    expect(confidenceLabel(undefined).label).toBe("—");
  });

  test("due bucketing relative to now", () => {
    const now = 1_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    expect(dueBucket({ latestMs: now - day }, now)).toBe("overdue");
    expect(dueBucket({ latestMs: now + day / 2 }, now)).toBe("today");
    expect(dueBucket({ latestMs: now + 2 * day }, now)).toBe("soon");
    expect(dueBucket({ latestMs: now + 10 * day }, now)).toBe("later");
    expect(dueBucket({ latestMs: now + 40 * day }, now)).toBe("someday");
    expect(dueBucket(undefined, now)).toBe("someday");
  });

  test("groups are ordered overdue-first and non-empty", () => {
    const now = 1_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const commitments: Commitment[] = [
      { id: "a", agentId: "main", status: "pending", dueWindow: { latestMs: now + 40 * day } },
      { id: "b", agentId: "main", status: "pending", dueWindow: { latestMs: now - day } },
    ];
    const groups = groupByDue(commitments, now);
    expect(groups[0]?.bucket).toBe("overdue");
    expect(groups.map((g) => g.items.length).every((n) => n > 0)).toBe(true);
  });

  test("formatDue returns null without a window", () => {
    expect(formatDue(undefined)).toBeNull();
    expect(formatDue({ latestMs: 1_700_000_000_000 })).toBeTruthy();
  });
});

test.describe("backup-types.parseBackupOutput", () => {
  const sample = [
    "Backup archive: /Users/x/2026-08-13-openclaw-backup.tar.gz",
    "Included 1 path:",
    "- state: ~/.openclaw",
    "Skipped 1 path:",
    "- workspace: ~/.openclaw/workspace (covered by ~/.openclaw)",
    "Dry run only; archive was not written.",
  ].join("\n");

  test("parses archive path, included/skipped, and dry-run flag", () => {
    const r = parseBackupOutput(sample);
    expect(r.archivePath).toContain("openclaw-backup.tar.gz");
    expect(r.included).toEqual([{ label: "state", detail: "~/.openclaw" }]);
    expect(r.skipped[0]?.label).toBe("workspace");
    expect(r.dryRun).toBe(true);
  });

  test("real create (no dry-run line) is not flagged dryRun", () => {
    const r = parseBackupOutput("Backup archive: /tmp/x.tar.gz\nIncluded 1 path:\n- state: ~/.openclaw");
    expect(r.dryRun).toBe(false);
    expect(r.archivePath).toBe("/tmp/x.tar.gz");
  });
});

test.describe("exec-approvals-types", () => {
  const base = (askEffective: string): ApprovalsSnapshot => ({
    path: "/x",
    exists: true,
    agents: { "*": { allowlist: ["git *", "npm run *"] } },
    defaults: {},
    scopes: [{ scopeLabel: "tools.exec", configPath: "tools.exec", ask: { effective: askEffective } }],
    note: "n",
  });

  const withMode = (mode: string): ApprovalsSnapshot => ({
    path: "/x",
    exists: true,
    agents: {},
    defaults: {},
    scopes: [{ scopeLabel: "tools.exec", configPath: "tools.exec", mode: { effective: mode } }],
  });

  test("deriveMode: ask off -> autonomous, otherwise guarded", () => {
    expect(deriveMode(base("off"))).toBe("autonomous");
    expect(deriveMode(base("on-miss"))).toBe("guarded");
    expect(deriveMode(base("always"))).toBe("guarded");
  });

  test("deriveMode: mode full -> autonomous, mode ask -> guarded", () => {
    expect(deriveMode(withMode("full"))).toBe("autonomous");
    expect(deriveMode(withMode("ask"))).toBe("guarded");
    expect(deriveMode(withMode("allowlist"))).toBe("guarded");
  });

  test("deriveMode defaults to autonomous when ask is unset", () => {
    const snap: ApprovalsSnapshot = { path: "", exists: false, agents: {}, defaults: {}, scopes: [{ scopeLabel: "tools.exec", configPath: "tools.exec" }] };
    expect(deriveMode(snap)).toBe("autonomous");
  });

  test("allowlistFor returns the wildcard agent patterns", () => {
    expect(allowlistFor(base("off"), "*")).toEqual(["git *", "npm run *"]);
    expect(allowlistFor(base("off"), "missing")).toEqual([]);
  });
});
