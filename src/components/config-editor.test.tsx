/**
 * Vitest jsdom pin for the pure helpers in `config-editor.tsx` — the
 * fragile, 3,165-line monolithic config editor. Per D-03 (01-CONTEXT.md),
 * the only source change that made these importable is the mechanical
 * addition of the `export` keyword to eight pure helpers — no logic
 * change, no reformatting, no test-hook attributes added to the view.
 *
 * These are pinning tests: they encode current behavior exactly as it is
 * today. A failure here means behavior moved — someone must decide whether
 * that was intended, not "fix the test to make it pass again."
 *
 * `redactConfigForDisplay` is the security-relevant pin: it is the
 * client-side secret masking shown when "Reveal secrets" is off. Per
 * 01-RESEARCH.md Pitfall 1, this helper is display-only and does not
 * redact what `/api/config` actually returns over the wire (Phase 2/6
 * owns fixing that leak) — this file only pins that the *display* masking
 * behaves as it does today.
 *
 * Only synthetic secret-shaped values are used below — never a value read
 * from `~/.openclaw` or `~/instances/dev`, and this file does not import
 * or read any real config file.
 */

import { describe, test, expect } from "vitest";
import {
  getLabel,
  getHelp,
  isSensitivePath,
  inferFieldType,
  extractEnumValues,
  emptyValueForType,
  normalizedJsonString,
  redactConfigForDisplay,
} from "@/components/config-editor";

/* ── getLabel / getHelp ───────────────────────────── */

describe("config-editor: getLabel", () => {
  test("uses the hint's label when present", () => {
    expect(getLabel({ "models.default": { label: "Default model" } }, "models.default", "fallback")).toBe(
      "Default model"
    );
  });

  test("falls back to the provided fallback when no hint exists", () => {
    expect(getLabel({}, "unknown.path", "Unknown Path")).toBe("Unknown Path");
  });
});

describe("config-editor: getHelp", () => {
  test("uses the hint's help text when present", () => {
    expect(getHelp({ "models.default": { help: "Model used when none is specified" } }, "models.default")).toBe(
      "Model used when none is specified"
    );
  });

  test("returns empty string when no hint exists", () => {
    expect(getHelp({}, "unknown.path")).toBe("");
  });
});

/* ── isSensitivePath ──────────────────────────────── */
//
// Driven by the `hints` map (isSensitiveConfigPath in config-changes.ts):
// an explicit `hints[path].sensitive` flag, OR the path's top-level
// section being in SENSITIVE_SECTIONS ("env"/"auth"), OR the last path
// segment matching a sensitive-looking key pattern (api key/secret/
// password/token/credential).

describe("config-editor: isSensitivePath", () => {
  test("hint-driven: a path explicitly flagged sensitive in hints is sensitive", () => {
    expect(isSensitivePath({ "custom.myValue": { sensitive: true } }, "custom.myValue")).toBe(true);
  });

  test("hint-driven: a path not flagged and with no matching key pattern is not sensitive", () => {
    expect(isSensitivePath({ "custom.myValue": { sensitive: false } }, "custom.myValue")).toBe(false);
    expect(isSensitivePath({}, "models.providers.anthropic.baseUrl")).toBe(false);
  });

  test("section-driven: paths under 'env' or 'auth' are sensitive regardless of hints", () => {
    expect(isSensitivePath({}, "env.SOME_VAR")).toBe(true);
    expect(isSensitivePath({}, "auth.mode")).toBe(true);
  });

  test("key-pattern-driven: a path whose last segment looks like a secret is sensitive without a hint", () => {
    expect(isSensitivePath({}, "models.providers.anthropic.apiKey")).toBe(true);
    expect(isSensitivePath({}, "custom.token")).toBe(true);
  });
});

/* ── inferFieldType ───────────────────────────────── */

describe("config-editor: inferFieldType", () => {
  test("hint enum takes precedence over schema", () => {
    expect(inferFieldType({ type: "string" }, { enum: ["a", "b"] })).toBe("enum");
  });

  test("schema.enum is treated as enum", () => {
    expect(inferFieldType({ enum: ["a", "b"] }, undefined)).toBe("enum");
  });

  test("schema.const is treated as enum", () => {
    expect(inferFieldType({ const: "fixed" }, undefined)).toBe("enum");
  });

  test("anyOf/oneOf enum-like path: all variants are const/enum/string, 10 or fewer", () => {
    expect(
      inferFieldType(
        { anyOf: [{ const: "a" }, { const: "b" }, { type: "string" }] },
        undefined
      )
    ).toBe("enum");
  });

  test("anyOf/oneOf ceiling: more than 10 variants stops being enum-like", () => {
    const elevenVariants = Array.from({ length: 11 }, (_, i) => ({ const: `v${i}` }));
    expect(inferFieldType({ anyOf: elevenVariants }, undefined)).toBe("unknown");
  });

  test("each schema.type maps to its field type, including integer -> number", () => {
    expect(inferFieldType({ type: "string" }, undefined)).toBe("string");
    expect(inferFieldType({ type: "number" }, undefined)).toBe("number");
    expect(inferFieldType({ type: "integer" }, undefined)).toBe("number");
    expect(inferFieldType({ type: "boolean" }, undefined)).toBe("boolean");
    expect(inferFieldType({ type: "array" }, undefined)).toBe("array");
    expect(inferFieldType({ type: "object" }, undefined)).toBe("object");
  });

  test("absent schema returns 'unknown'", () => {
    expect(inferFieldType(undefined, undefined)).toBe("unknown");
  });
});

/* ── extractEnumValues ────────────────────────────── */

describe("config-editor: extractEnumValues", () => {
  test("undefined schema returns an empty array", () => {
    expect(extractEnumValues(undefined)).toEqual([]);
  });

  test("schema.enum is returned as-is", () => {
    expect(extractEnumValues({ enum: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });

  test("schema.const is stringified into a single-element array", () => {
    expect(extractEnumValues({ const: 42 })).toEqual(["42"]);
  });

  test("anyOf/oneOf accumulation, including mixed const-plus-enum variants", () => {
    expect(
      extractEnumValues({
        anyOf: [{ const: "solo" }, { enum: ["x", "y"] }, { type: "string" }],
      })
    ).toEqual(["solo", "x", "y"]);
  });

  test("no enum-like fields at all: returns an empty array", () => {
    expect(extractEnumValues({ type: "string" })).toEqual([]);
  });
});

/* ── emptyValueForType ────────────────────────────── */

describe("config-editor: emptyValueForType", () => {
  test("string and enum arms return an empty string", () => {
    expect(emptyValueForType("string", undefined)).toBe("");
    expect(emptyValueForType("enum", undefined)).toBe("");
  });

  test("number arm returns 0", () => {
    expect(emptyValueForType("number", undefined)).toBe(0);
  });

  test("boolean arm returns false", () => {
    expect(emptyValueForType("boolean", undefined)).toBe(false);
  });

  test("array arm returns an empty array", () => {
    expect(emptyValueForType("array", undefined)).toEqual([]);
  });

  test("object arm returns an empty object", () => {
    expect(emptyValueForType("object", undefined)).toEqual({});
  });

  test("default arm: schema.type array falls back to an empty array", () => {
    expect(emptyValueForType("unknown", { type: "array" })).toEqual([]);
  });

  test("default arm: anything else falls back to an empty string", () => {
    expect(emptyValueForType("unknown", { type: "object" })).toBe("");
    expect(emptyValueForType("unknown", undefined)).toBe("");
  });
});

/* ── normalizedJsonString ─────────────────────────── */

describe("config-editor: normalizedJsonString", () => {
  test("valid JSON is reformatted with 2-space indent", () => {
    expect(normalizedJsonString('{"a":1,"b":[1,2]}')).toBe(
      JSON.stringify({ a: 1, b: [1, 2] }, null, 2)
    );
  });

  test("invalid JSON returns null", () => {
    expect(normalizedJsonString("{not valid json")).toBeNull();
  });
});

/* ── redactConfigForDisplay ───────────────────────── */
//
// The security-relevant pin. Synthetic secret-shaped strings only.

describe("config-editor: redactConfigForDisplay", () => {
  const hints = {
    "auth.token": { sensitive: true },
  };

  test("a sensitive string longer than 8 characters masks to the long mask", () => {
    const result = redactConfigForDisplay(
      { token: "synthetic-secret-shaped-value-over-eight-chars" },
      hints,
      "auth"
    ) as Record<string, unknown>;
    expect(result.token).toBe("••••••••");
  });

  test("a sensitive string of 8 characters or fewer masks to the short mask", () => {
    const result = redactConfigForDisplay({ token: "short12" }, hints, "auth") as Record<string, unknown>;
    expect(result.token).toBe("••••");
  });

  test("a non-sensitive string passes through untouched", () => {
    const result = redactConfigForDisplay(
      { baseUrl: "https://example.com/api" },
      hints,
      "models.providers.custom"
    ) as Record<string, unknown>;
    expect(result.baseUrl).toBe("https://example.com/api");
  });

  test("nesting and arrays recurse with correct path construction (a.b[0].c)", () => {
    // Use a non-sensitive top-level section ("custom", not "auth"/"env")
    // and a field name that does not match any SENSITIVE_KEY_PATTERNS
    // (api key/secret/password/token/credential), so only the explicit
    // per-path hint drives masking here — isolating path-construction
    // behavior from isSensitivePath's section-wide and key-pattern rules.
    const nestedHints = {
      "custom.entries[0].customField": { sensitive: true },
    };
    const result = redactConfigForDisplay(
      { entries: [{ customField: "synthetic-flagged-value-here", label: "primary" }] },
      nestedHints,
      "custom"
    ) as { entries: { customField: string; label: string }[] };
    expect(result.entries[0].customField).toBe("••••••••");
    expect(result.entries[0].label).toBe("primary");
  });

  test("null, undefined, numbers and booleans pass through unchanged", () => {
    expect(redactConfigForDisplay(null, hints, "auth")).toBeNull();
    expect(redactConfigForDisplay(undefined, hints, "auth")).toBeUndefined();
    expect(redactConfigForDisplay(42, hints, "auth")).toBe(42);
    expect(redactConfigForDisplay(true, hints, "auth")).toBe(true);
    expect(redactConfigForDisplay(false, hints, "auth")).toBe(false);
  });
});
