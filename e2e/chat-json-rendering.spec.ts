/**
 * Unfenced JSON in a chat message used to render as flowing prose — braces and
 * quotes reflowed into the paragraph, keys wrapped mid-token. Programmatic
 * callers paste schemas and payloads in without fences all the time, so the
 * renderer finds them and fences them itself.
 *
 * The detector's test is `JSON.parse`, so these also pin the other half of the
 * promise: text that only looks a bit like JSON is left exactly as written.
 */

import { test, expect } from "@playwright/test";
import { __testables } from "../src/components/chat/markdown";

const { prepareMarkdown } = __testables;

// Verbatim from the knowledge-extraction prompt in the reported screenshot.
const REAL = `Extract a rich knowledge graph from text. Return ONLY a JSON object with this exact schema:
{
  "entities": [{"name": "string", "type": "person|project|tool|concept|preference", "summary": "string"}],
  "relations": [{"subject": "string", "predicate": "string", "object": "string", "fact": "string"}]
}

Rules:
- Extract ALL meaningful named entities
- Respond with the JSON object only — no prose, no code fences

Example input: "User prefers TypeScript."
Example output: {"entities":[{"name":"User","type":"person","summary":"The developer"},{"name":"TypeScript","type":"tool","summary":"Programming language"}],"relations":[{"subject":"User","predicate":"prefers","object":"TypeScript","fact":"User prefers TypeScript"}]}`;

test("the schema block becomes a fenced json block", () => {
  const out = prepareMarkdown(REAL);
  expect(out).toContain("```json\n{\n  \"entities\"");
});

test("the inline example payload is fenced too", () => {
  const out = prepareMarkdown(REAL);
  const fences = out.match(/```json/g) ?? [];
  expect(fences.length).toBe(2);
});

test("prose around the JSON is untouched", () => {
  const out = prepareMarkdown(REAL);
  expect(out).toContain("Extract ALL meaningful named entities");
  expect(out).toContain("Example input:");
});

test("prose containing a stray brace is left alone", () => {
  const prose = "Use the { key } placeholder when you write the template out by hand.";
  expect(prepareMarkdown(prose)).toContain("{ key }");
  expect(prepareMarkdown(prose)).not.toContain("```");
});

test("already-fenced JSON is not double-fenced", () => {
  const already = 'Here:\n\n```json\n{"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 77777}\n```\n';
  const out = prepareMarkdown(already);
  expect((out.match(/```/g) ?? []).length).toBe(2);
});

test("a tiny object stays inline", () => {
  const tiny = 'Result:\n{"ok": true}\n';
  expect(prepareMarkdown(tiny)).not.toContain("```");
});

test("a brace inside a string does not end the scan early", () => {
  const tricky = '{\n  "pattern": "a}b{c",\n  "note": "unbalanced braces live inside this string value"\n}';
  expect(prepareMarkdown(tricky)).toContain("```json");
});
