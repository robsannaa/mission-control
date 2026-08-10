/**
 * Read a result without leaving the page.
 *
 * A search result's snippet is a fragment chosen by the provider. When someone
 * wants the actual page, this fetches it through OpenClaw's own `web_fetch`
 * tool — the same call the agent makes — and returns the readable extract.
 *
 * Two things this deliberately is NOT: it is not a cache (nothing is stored),
 * and it is not a replacement for the source. Every response carries the final
 * URL so the UI can keep the original one click away, and the extract is capped
 * so this stays a preview rather than a copy of someone else's page.
 */

import { NextRequest, NextResponse } from "next/server";
import { invokeGatewayTool, ToolNotAvailableError } from "@/lib/gateway-tools";
import { unwrapExternalContent, plainifySnippet } from "@/components/search/providers";

export const dynamic = "force-dynamic";

/** Enough to read an article; short enough that this stays a preview. */
const MAX_CHARS = 20_000;

/** Readability can be slow on heavy pages, but the user is watching a spinner. */
const FETCH_TIMEOUT_MS = 45_000;

type WebFetchResult = {
  content?: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
};

type WebFetchPayload = {
  url?: string;
  finalUrl?: string;
  status?: number;
  title?: string;
  content?: string;
  text?: string;
  markdown?: string;
  truncated?: boolean;
  length?: number;
};

/** Turn whatever went wrong into one sentence a person can act on. */
function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (err instanceof ToolNotAvailableError || lower.includes("not available")) {
    return "This OpenClaw cannot fetch web pages — the web_fetch tool is not enabled.";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("abort")) {
    return "The page took too long to load. It may be slow or very large.";
  }
  if (lower.includes("econnrefused") || lower.includes("fetch failed")) {
    return "Could not reach OpenClaw. Check that the gateway is running.";
  }
  if (lower.includes("403") || lower.includes("forbidden")) {
    return "The site refused the request. Some sites block automated readers.";
  }
  if (lower.includes("404")) return "That page no longer exists.";
  return "The page could not be read.";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export async function POST(request: NextRequest) {
  let target: URL;
  try {
    const body = (await request.json()) as { url?: string };
    target = new URL(String(body.url ?? ""));
    // Only the public web. This endpoint must not become a way to read the
    // machine's own filesystem or private network through the gateway.
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    return NextResponse.json(
      { ok: false, reason: "That does not look like a web address." },
      { status: 400 },
    );
  }

  try {
    const result = await invokeGatewayTool<WebFetchResult>(
      "web_fetch",
      { url: target.toString() },
      FETCH_TIMEOUT_MS,
    );

    const raw = result?.content?.find((part) => part?.type === "text")?.text ?? "";
    let payload: WebFetchPayload = {};
    try {
      payload = JSON.parse(raw) as WebFetchPayload;
    } catch {
      // Some builds return the extract directly rather than a JSON envelope.
      payload = { content: raw };
    }

    const body = plainifySnippet(
      unwrapExternalContent(firstString(payload.content, payload.text, payload.markdown)),
    );
    const title = unwrapExternalContent(payload.title ?? "").trim();

    if (!body) {
      return NextResponse.json({
        ok: false,
        reason: "There was no readable text on that page — it may be mostly images or video.",
        finalUrl: payload.finalUrl || target.toString(),
      });
    }

    const clipped = body.length > MAX_CHARS;
    return NextResponse.json({
      ok: true,
      title,
      finalUrl: payload.finalUrl || payload.url || target.toString(),
      text: clipped ? body.slice(0, MAX_CHARS) : body,
      // True when either we clipped it, or web_fetch already did.
      truncated: clipped || payload.truncated === true,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, reason: describeFailure(err) }, { status: 200 });
  }
}
