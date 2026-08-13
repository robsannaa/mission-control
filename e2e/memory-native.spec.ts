import { expect, test } from "@playwright/test";
import {
  isBarrenReflection,
  memoryLead,
  parseMemoryEntries,
  parseReflections,
  scoreTone,
} from "../src/lib/memory-native-types";

test.describe("MEMORY.md parsing", () => {
  const sample = [
    "# Memory",
    "",
    "Intro line that is the preamble.",
    "",
    "## Response style",
    "",
    "Keep it short and actionable.",
    "Second line.",
    "",
    "## Versami",
    "",
    "Financial questions mean the ERP.",
    "",
  ].join("\n");

  test("splits into entries with heading + body, keeps preamble", () => {
    const { entries, preamble } = parseMemoryEntries(sample);
    expect(preamble).toContain("Intro line");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.heading).toBe("Response style");
    expect(entries[0]!.body).toBe("Keep it short and actionable.\nSecond line.");
    expect(entries[1]!.heading).toBe("Versami");
    expect(entries[1]!.body).toBe("Financial questions mean the ERP.");
  });

  test("entry offsets round-trip an edit", () => {
    const { entries } = parseMemoryEntries(sample);
    const target = entries[1]!;
    const edited = sample.slice(0, target.start) + "## Versami\n\nNew body.\n" + sample.slice(target.end);
    const reparsed = parseMemoryEntries(edited);
    expect(reparsed.entries[1]!.body).toBe("New body.");
    expect(reparsed.entries[0]!.body).toContain("short and actionable"); // untouched
  });

  test("no headings -> everything is preamble, zero entries (never fabricates)", () => {
    const { entries, preamble } = parseMemoryEntries("# Memory\n\nJust prose, no entries.");
    expect(entries).toHaveLength(0);
    expect(preamble).toContain("Just prose");
  });

  test("empty file yields nothing", () => {
    expect(parseMemoryEntries("").entries).toHaveLength(0);
  });
});

test.describe("DREAMS.md parsing", () => {
  const dreams = [
    "# Dream Diary",
    "",
    "<!-- openclaw:dreaming:diary:start -->",
    "---",
    "",
    "*August 10, 2026 at 3:00 AM GMT+2*",
    "",
    "A real reflection about the week.",
    "",
    "---",
    "",
    "*August 11, 2026 at 3:00 AM GMT+2*",
    "",
    "A memory trace surfaced, but details were unavailable in this run.",
    "",
  ].join("\n");

  test("parses reflections newest-first with timestamp + text", () => {
    const refs = parseReflections(dreams);
    expect(refs).toHaveLength(2);
    // newest first
    expect(refs[0]!.timestamp).toContain("August 11");
    expect(refs[1]!.text).toBe("A real reflection about the week.");
  });

  test("flags barren reflections", () => {
    const refs = parseReflections(dreams);
    const barren = refs.find((r) => /details were unavailable/.test(r.text))!;
    expect(isBarrenReflection(barren)).toBe(true);
    expect(isBarrenReflection({ id: "x", timestamp: "", text: "A real reflection about the week." })).toBe(false);
  });
});

test.describe("helpers", () => {
  test("memoryLead takes the first non-empty line, truncates", () => {
    expect(memoryLead("- first\nsecond")).toBe("first");
    expect(memoryLead("x".repeat(200)).endsWith("…")).toBe(true);
  });

  test("scoreTone buckets", () => {
    expect(scoreTone(0.9)).toBe("success");
    expect(scoreTone(0.5)).toBe("warning");
    expect(scoreTone(0.1)).toBe("secondary");
    expect(scoreTone(null)).toBe("secondary");
  });
});
