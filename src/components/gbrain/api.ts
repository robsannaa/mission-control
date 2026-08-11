"use client";

import type { RunResult } from "./types";

/**
 * Run a catalog command through the shared, safety-gated facade
 * (POST /api/g-brain — argv-only, first-token allowlist, see src/lib/gbrain.ts).
 * Every G-Brain screen in this feature calls through this one function so
 * there is exactly one place that talks to the API.
 */
export async function runGbrainCommand(
  id: string,
  values?: Record<string, string>,
  confirm?: boolean,
): Promise<RunResult> {
  try {
    const res = await fetch("/api/g-brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, values: values ?? {}, confirm: Boolean(confirm) }),
    });
    const data = (await res.json()) as RunResult;
    return data;
  } catch (e) {
    return { ok: false, stdout: "", error: e instanceof Error ? e.message : String(e) };
  }
}
