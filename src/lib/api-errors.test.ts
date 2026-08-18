/**
 * Unit coverage for `src/lib/api-errors.ts` — the canonical error envelope
 * builders. Every assertion checks status, `ok`, and `error` together so a
 * future shape drift fails loudly.
 */
import { describe, test, expect } from "vitest";
import { z } from "zod";
import { apiError, badRequest, conflict, notFound, payloadTooLarge, serverError, validationFailed } from "./api-errors";

describe("apiError", () => {
  test("produces the requested status and { ok: false, error } with no details key when omitted", async () => {
    const res = apiError("x", 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toStrictEqual({ ok: false, error: "x" });
    expect(body).not.toHaveProperty("details");
  });

  test("includes details when provided", async () => {
    const res = apiError("y", 400, { field: "name" });
    const body = await res.json();
    expect(body).toStrictEqual({ ok: false, error: "y", details: { field: "name" } });
  });
});

describe("named builders", () => {
  test("badRequest → 400", async () => {
    const res = badRequest("bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toStrictEqual({ ok: false, error: "bad" });
  });

  test("conflict → 409", async () => {
    const res = conflict("dup");
    expect(res.status).toBe(409);
    expect(await res.json()).toStrictEqual({ ok: false, error: "dup" });
  });

  test("notFound → 404 with default message", async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect(await res.json()).toStrictEqual({ ok: false, error: "Not found" });
  });

  test("payloadTooLarge → 413", async () => {
    const res = payloadTooLarge();
    expect(res.status).toBe(413);
    expect(await res.json()).toStrictEqual({ ok: false, error: "Payload too large" });
  });

  test("serverError → 500", async () => {
    const res = serverError("boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toStrictEqual({ ok: false, error: "boom" });
  });
});

describe("validationFailed", () => {
  test("produces 400, ok false, and a details tree derived from the Zod issues", async () => {
    const schema = z.object({ name: z.string().min(1, "name required") });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;

    const res = validationFailed(result.error);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.details).toBeDefined();
    expect(body.details).toHaveProperty("properties");
  });

  test("uses the first issue's message as the top-level error", async () => {
    const schema = z.object({ name: z.string().regex(/^[a-z]+$/, "lowercase only") });
    const result = schema.safeParse({ name: "BAD" });
    if (result.success) throw new Error("expected failure");

    const res = validationFailed(result.error);
    const body = await res.json();
    expect(body.error).toBe("lowercase only");
  });
});
