"use client";

/**
 * One report the user can hand to whoever is helping them.
 *
 * The redaction happens on the server — the gateway token appears zero times
 * and home directories render as `~`. That guarantee is stated in the dialog,
 * because a person about to paste this into a support thread deserves to know
 * what is in it before they do.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "./primitives";
import { errorMessage } from "./sse";

export function ReportDialog({ onClose }: { onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withTranscript, setWithTranscript] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/doctor/report?format=json${withTranscript ? "&transcript=1" : ""}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          throw new Error(await errorMessage(res, `The report could not be built (${res.status}).`));
        }
        const data = (await res.json()) as { markdown: string };
        if (cancelled) return;
        setMarkdown(data.markdown);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [withTranscript]);

  const copy = useCallback(async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Your browser would not let Mission Control use the clipboard.");
    }
  }, [markdown]);

  const download = useCallback(() => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openclaw-health-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [markdown]);

  return (
    <Modal
      title="Share a health report"
      subtitle="Everything on this page, written out — with your gateway token and your home folder taken out of it."
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={withTranscript}
              onChange={(e) => setWithTranscript(e.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Include the full command output
          </label>
          <div className="flex items-center gap-2.5">
            <Button size="sm" variant="outline" onClick={download} disabled={!markdown}>
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
            <Button size="sm" onClick={copy} disabled={!markdown} data-autofocus>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Building the report…
        </p>
      ) : error ? (
        <p className="text-sm leading-relaxed text-danger-fg">{error}</p>
      ) : (
        <pre className="max-h-[52vh] overflow-auto rounded-xl border border-border-subtle bg-surface-inset p-4 font-mono text-xs leading-relaxed text-fg-secondary">
          {markdown}
        </pre>
      )}
    </Modal>
  );
}
