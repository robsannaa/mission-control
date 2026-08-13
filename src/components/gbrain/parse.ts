/**
 * Parsers for the plain-text CLI output G-Brain prints when there is no
 * `--json` shape for a command (or the flag isn't honoured by that
 * subcommand). Every parser is best-effort and returns `null`/`[]` on a
 * shape it doesn't recognise — callers fall back to showing the raw text
 * rather than throwing, since a CLI's exact wording is not a contract.
 */

export type StatsSummary = {
  pages: number | null;
  chunks: number | null;
  embedded: number | null;
  links: number | null;
  tags: number | null;
  timeline: number | null;
  byType: Array<{ type: string; count: number }>;
};

export function parseStats(text: string | undefined | null): StatsSummary | null {
  if (!text) return null;
  const num = (label: string) => {
    const m = text.match(new RegExp(`${label}:\\s*(\\d+)`, "i"));
    return m ? Number(m[1]) : null;
  };
  const byType: Array<{ type: string; count: number }> = [];
  const typeSection = text.split(/By type:/i)[1];
  if (typeSection) {
    for (const line of typeSection.split("\n")) {
      const m = line.match(/^\s*([\w-]+):\s*(\d+)\s*$/);
      if (m) byType.push({ type: m[1], count: Number(m[2]) });
    }
  }
  const pages = num("Pages");
  if (pages == null && byType.length === 0) return null;
  return {
    pages,
    chunks: num("Chunks"),
    embedded: num("Embedded"),
    links: num("Links"),
    tags: num("Tags"),
    timeline: num("Timeline"),
    byType: byType.sort((a, b) => b.count - a.count),
  };
}

export type JobTypeRow = {
  type: string;
  total: number;
  done: number;
  failed: number;
  dead: number;
  avgTime: string;
};

export type JobsStatsSummary = {
  rows: JobTypeRow[];
  waiting: number | null;
  active: number | null;
  stalled: number | null;
  warnings: string[];
  leasePressure: string | null;
};

export function parseJobsStats(text: string | undefined | null): JobsStatsSummary | null {
  if (!text) return null;
  const rows: JobTypeRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([\w-]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
    if (m && m[1] !== "Type") {
      rows.push({ type: m[1], total: Number(m[2]), done: Number(m[3]), failed: Number(m[4]), dead: Number(m[5]), avgTime: m[6] });
    }
  }
  const qm = text.match(/Queue health:\s*(\d+)\s*waiting,\s*(\d+)\s*active(?:,\s*(\d+)\s*stalled)?/i);
  const warnings: string[] = [];
  const warnMatch = text.match(/⚠\s*(?:WEDGED QUEUE|[^\n]*)[\s\S]*?(?=\n\s*Lease pressure|\n\n|$)/g);
  if (warnMatch) {
    for (const w of warnMatch) warnings.push(w.trim());
  }
  const leaseMatch = text.match(/Lease pressure[^\n]*/i);
  if (rows.length === 0 && !qm) return null;
  return {
    rows,
    waiting: qm ? Number(qm[1]) : null,
    active: qm ? Number(qm[2]) : null,
    stalled: qm && qm[3] ? Number(qm[3]) : null,
    warnings,
    leasePressure: leaseMatch ? leaseMatch[0].trim() : null,
  };
}

export type HealthSummary = {
  healthScore: number | null;
  healthMax: number | null;
  embedCoveragePct: number | null;
  missingEmbeddings: number | null;
  stalePages: number | null;
  orphanPages: number | null;
  linkCoveragePct: number | null;
  timelineCoverageEntityPct: number | null;
  timelineDensity: string | null;
  mostConnected: Array<{ slug: string; count: number }>;
};

export function parseHealth(text: string | undefined | null): HealthSummary | null {
  if (!text) return null;
  const scoreM = text.match(/Health score:\s*(\d+)\s*\/\s*(\d+)/i);
  const pct = (label: string) => {
    const m = text.match(new RegExp(`${label}:\\s*([\\d.]+)%`, "i"));
    return m ? Number(m[1]) : null;
  };
  const num = (label: string) => {
    const m = text.match(new RegExp(`${label}:\\s*(\\d+)`, "i"));
    return m ? Number(m[1]) : null;
  };
  const densityM = text.match(/Timeline density[^:]*:\s*([^\n]+)/i);
  const mostConnected: Array<{ slug: string; count: number }> = [];
  const section = text.split(/Most connected entities:/i)[1];
  if (section) {
    for (const line of section.split("\n")) {
      const m = line.match(/^\s*([\w./-]+):\s*(\d+)\s*links?\s*$/i);
      if (m) mostConnected.push({ slug: m[1], count: Number(m[2]) });
    }
  }
  if (!scoreM && mostConnected.length === 0) return null;
  return {
    healthScore: scoreM ? Number(scoreM[1]) : null,
    healthMax: scoreM ? Number(scoreM[2]) : null,
    embedCoveragePct: pct("Embed coverage"),
    missingEmbeddings: num("Missing embeddings"),
    stalePages: num("Stale pages"),
    orphanPages: num("Orphan pages"),
    linkCoveragePct: pct("Link coverage \\(entities\\)"),
    timelineCoverageEntityPct: pct("Timeline coverage \\(entity pages\\)"),
    timelineDensity: densityM ? densityM[1].trim() : null,
    mostConnected,
  };
}

export type SearchHit = {
  score: number;
  slug: string;
  snippet: string;
  stale: boolean;
};

/** Parses the `[score] slug -- snippet` blocks shared by search/query/ask. */
export function parseSearchResults(text: string | undefined | null): SearchHit[] {
  if (!text) return [];
  const hits: SearchHit[] = [];
  const re = /\[(\d+\.\d+)\]\s+(\S+)\s+--\s+([\s\S]*?)(?=\n\[\d+\.\d+\]\s+\S+\s+--|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let snippet = m[3].trim();
    let stale = false;
    if (/\(stale\)\s*$/.test(snippet)) {
      stale = true;
      snippet = snippet.replace(/\(stale\)\s*$/, "").trim();
    }
    hits.push({ score: Number(m[1]), slug: m[2], snippet, stale });
  }
  return hits;
}

export type PageListItem = {
  slug: string;
  type: string;
  date: string;
  title: string;
};

/** Parses the tab-separated output of `gbrain list`. */
export function parsePageList(text: string | undefined | null): PageListItem[] {
  if (!text) return [];
  const items: PageListItem[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || !line.includes("\t")) continue;
    const [slug, type, date, ...rest] = line.split("\t");
    if (!slug || !type) continue;
    items.push({ slug: slug.trim(), type: type.trim(), date: (date || "").trim(), title: rest.join("\t").trim() });
  }
  return items;
}

export type GraphEdge = { source: string; relation: string; target: string; depth: number };

/** Parses the ASCII tree output of `gbrain graph-query`. */
export function parseGraphQuery(text: string | undefined | null): { root: string | null; edges: GraphEdge[] } {
  if (!text) return { root: null, edges: [] };
  const rootM = text.match(/^\[depth 0\]\s+(\S+)/m);
  const root = rootM ? rootM[1] : null;
  const edges: GraphEdge[] = [];
  const nodeAtDepth: string[] = root ? [root] : [];

  // The CLI emits a depth-first ASCII tree. Tracking the most recent node at
  // each depth reconstructs the source of every edge without depending on the
  // exact indentation characters (which have changed between G-Brain builds).
  for (const line of text.split("\n")) {
    const m = line.match(/--(\S+)->\s+(\S+)\s+\(depth (\d+)\)/);
    if (!m) continue;
    const depth = Number(m[3]);
    const target = m[2];
    const source = nodeAtDepth[Math.max(0, depth - 1)] || root;
    if (source) edges.push({ source, relation: m[1], target, depth });
    nodeAtDepth[depth] = target;
    nodeAtDepth.length = depth + 1;
  }
  return { root, edges };
}

export type TimelineEntry = { date: string; text: string };

/** Parses `<ISO date>  <text>` lines from `gbrain timeline`. */
export function parseTimeline(text: string | undefined | null): TimelineEntry[] {
  if (!text) return [];
  const entries: TimelineEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
    if (m) entries.push({ date: m[1], text: m[2].trim() });
  }
  return entries;
}

export type HistoryEntry = { version: string; date: string; preview: string };

/** Parses `#171  2026-08-08T19:30:11  <preview>` lines from `gbrain history`. */
export function parseHistory(text: string | undefined | null): HistoryEntry[] {
  if (!text) return [];
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^#(\S+)\s+(\S+)\s+(.*)$/);
    if (m) entries.push({ version: m[1], date: m[2], preview: m[3].trim() });
  }
  return entries;
}

/** Splits `---\nfrontmatter\n---\nbody` into a small key/value map + the body. */
export function splitFrontmatter(text: string | undefined | null): { meta: Record<string, string>; body: string } {
  const source = text || "";
  const m = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s?(.*)$/);
    if (kv) {
      lastKey = kv[1];
      if (kv[2]) meta[lastKey] = kv[2].replace(/^['"]|['"]$/g, "");
    } else if (lastKey && /^\s*-\s*/.test(line)) {
      const item = line.replace(/^\s*-\s*/, "").trim();
      meta[lastKey] = meta[lastKey] ? `${meta[lastKey]}, ${item}` : item;
    }
  }
  return { meta, body: m[2] };
}

export type JobRow = {
  id: string;
  name: string;
  status: string;
  queue: string;
  time: string;
  created: string;
};

/** Parses the fixed-column table output of `gbrain jobs list`. */
export function parseJobsList(text: string | undefined | null): JobRow[] {
  if (!text) return [];
  const rows: JobRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/);
    if (m && m[2] !== "Name") {
      rows.push({ id: m[1], name: m[2], status: m[3], queue: m[4], time: m[5], created: m[6] });
    }
  }
  return rows;
}

/** Best-effort tag list parser — `gbrain tags` prints "No tags." or one per line. */
export function parseTags(text: string | undefined | null): string[] {
  if (!text) return [];
  if (/^no tags\.?$/i.test(text.trim())) return [];
  return text
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}
