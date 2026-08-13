import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getOpenClawHome } from "@/lib/paths";
import { questionsAreSimilar, validateQuestion } from "./protocol";
import type {
  CreateInteractionInput,
  InteractionListFilter,
  InteractionRequest,
  InteractionResolution,
  InteractionStatus,
  WorkflowSource,
} from "./types";

const exec = promisify(execFile);
const DEFAULT_TENANT = "local";
const DEFAULT_USER = "owner";
const ANSWERED_SOURCE_COOLDOWN_MS = 60 * 60 * 1000;

let initializedPath: string | null = null;
let initPromise: Promise<void> | null = null;

function dbPath(): string {
  return process.env.MISSION_CONTROL_INTERACTION_DB?.trim() ||
    join(getOpenClawHome(), "mission-control", "interactions.db");
}

export function getInteractionDbPath(): string {
  return dbPath();
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function sqlite(args: string[], timeout = 20_000): Promise<string> {
  try {
    const result = await exec("sqlite3", args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("sqlite3 is required for the Mission Control interaction store");
    }
    throw error;
  }
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS interaction_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  reason TEXT,
  source_json TEXT NOT NULL,
  choices_json TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  answered_at_ms INTEGER,
  expires_at_ms INTEGER,
  idempotency_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_interactions_tenant_status_created
  ON interaction_requests(tenant_id, status, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_user_status
  ON interaction_requests(tenant_id, user_id, status, updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS interaction_responses (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(interaction_id) REFERENCES interaction_requests(id)
);
CREATE TABLE IF NOT EXISTS interaction_events (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(interaction_id) REFERENCES interaction_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_interaction_events_request
  ON interaction_events(interaction_id, created_at_ms);
INSERT INTO interaction_events (id, interaction_id, tenant_id, event_type, detail_json, created_at_ms)
SELECT lower(hex(randomblob(16))), current.id, current.tenant_id, 'cancelled',
  '{"reason":"superseded_duplicate"}', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM interaction_requests AS current
WHERE current.status IN ('open','answered','resuming')
  AND EXISTS (
    SELECT 1 FROM interaction_requests AS newer
    WHERE newer.tenant_id = current.tenant_id
      AND newer.user_id = current.user_id
      AND json_extract(newer.source_json, '$.kind') = json_extract(current.source_json, '$.kind')
      AND json_extract(newer.source_json, '$.id') = json_extract(current.source_json, '$.id')
      AND newer.status IN ('open','answered','resuming')
      AND (newer.created_at_ms > current.created_at_ms
        OR (newer.created_at_ms = current.created_at_ms AND newer.id > current.id))
  );
UPDATE interaction_requests AS current
SET status = 'cancelled', updated_at_ms = CAST(strftime('%s','now') AS INTEGER) * 1000,
  version = version + 1
WHERE current.status IN ('open','answered','resuming')
  AND EXISTS (
    SELECT 1 FROM interaction_requests AS newer
    WHERE newer.tenant_id = current.tenant_id
      AND newer.user_id = current.user_id
      AND json_extract(newer.source_json, '$.kind') = json_extract(current.source_json, '$.kind')
      AND json_extract(newer.source_json, '$.id') = json_extract(current.source_json, '$.id')
      AND newer.status IN ('open','answered','resuming')
      AND (newer.created_at_ms > current.created_at_ms
        OR (newer.created_at_ms = current.created_at_ms AND newer.id > current.id))
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_one_active_source
  ON interaction_requests(
    tenant_id,
    user_id,
    json_extract(source_json, '$.kind'),
    json_extract(source_json, '$.id')
  ) WHERE status IN ('open','answered','resuming');
`;

export async function ensureInteractionStore(): Promise<void> {
  const path = dbPath();
  if (initializedPath === path) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await mkdir(dirname(path), { recursive: true });
    await sqlite([path, SCHEMA], 30_000);
    initializedPath = path;
  })();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function query<T>(sql: string): Promise<T[]> {
  await ensureInteractionStore();
  const out = await sqlite(["-cmd", ".timeout 5000", "-json", dbPath(), sql]);
  const text = out.trim();
  if (!text) return [];
  const value = JSON.parse(text) as T[];
  return Array.isArray(value) ? value : [];
}

async function execute(sql: string): Promise<void> {
  await ensureInteractionStore();
  await sqlite([dbPath(), `PRAGMA busy_timeout=5000;\n${sql}`], 30_000);
}

type InteractionRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string | null;
  kind: InteractionRequest["kind"];
  status: InteractionStatus;
  title: string;
  question: string;
  context: string | null;
  reason: string | null;
  source_json: string;
  choices_json: string;
  answer: string | null;
  answered_at_ms: number | null;
  expires_at_ms: number | null;
  idempotency_key: string;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
  version: number;
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function fromRow(row: InteractionRow): InteractionRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    agentId: row.agent_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    question: row.question,
    context: row.context,
    reason: row.reason,
    source: parseJson<WorkflowSource>(row.source_json, { kind: "system", id: "unknown" }),
    choices: parseJson(row.choices_json, []),
    answer: row.answer,
    answeredAt: row.answered_at_ms,
    expiresAt: row.expires_at_ms,
    idempotencyKey: row.idempotency_key,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    version: row.version,
  };
}

export async function createInteraction(input: CreateInteractionInput): Promise<InteractionRequest> {
  const errors = validateQuestion(input);
  if (!input.idempotencyKey.trim()) errors.push("idempotencyKey is required");
  if (!input.source?.id?.trim()) errors.push("source.id is required");
  if (errors.length) throw new Error(errors.join("; "));

  const id = randomUUID();
  const now = Date.now();
  const tenantId = input.tenantId?.trim() || DEFAULT_TENANT;
  const userId = input.userId?.trim() || DEFAULT_USER;

  // An isolated recurring job can ask the same uncertainty again on its next
  // tick because the model rephrases it and has a new run id. A recent answer
  // is still the user's resolution: do not create another badge/notification
  // for equivalent wording from the same source. Skips are intentionally not
  // reused, and a materially different question is still allowed through.
  const recentResolved = await query<InteractionRow>(`
    SELECT * FROM interaction_requests
    WHERE tenant_id = ${sqlValue(tenantId)} AND user_id = ${sqlValue(userId)}
      AND status IN ('answered','resuming','completed')
      AND answer IS NOT NULL AND answered_at_ms >= ${now - ANSWERED_SOURCE_COOLDOWN_MS}
      AND json_extract(source_json, '$.kind') = ${sqlValue(input.source.kind)}
      AND json_extract(source_json, '$.id') = ${sqlValue(input.source.id)}
    ORDER BY answered_at_ms DESC LIMIT 10;
  `);
  const resolvedMatch = recentResolved.find((row) =>
    questionsAreSimilar(row.question, input.question),
  );
  if (resolvedMatch) return fromRow(resolvedMatch);

  await execute(`
BEGIN IMMEDIATE;
INSERT OR IGNORE INTO interaction_requests (
  id, tenant_id, user_id, agent_id, kind, status, title, question, context,
  reason, source_json, choices_json, expires_at_ms, idempotency_key,
  metadata_json, created_at_ms, updated_at_ms, version
) VALUES (
  ${sqlValue(id)}, ${sqlValue(tenantId)}, ${sqlValue(userId)}, ${sqlValue(input.agentId)},
  ${sqlValue(input.kind || "clarification")}, 'open', ${sqlValue(input.title.trim())},
  ${sqlValue(input.question.trim())}, ${sqlValue(input.context?.trim() || null)},
  ${sqlValue(input.reason?.trim() || null)}, ${sqlValue(JSON.stringify(input.source))},
  ${sqlValue(JSON.stringify(input.choices || []))}, ${sqlValue(input.expiresAt)},
  ${sqlValue(input.idempotencyKey.trim())}, ${sqlValue(JSON.stringify(input.metadata || {}))},
  ${now}, ${now}, 1
);
INSERT INTO interaction_events (id, interaction_id, tenant_id, event_type, detail_json, created_at_ms)
SELECT ${sqlValue(randomUUID())}, id, tenant_id, 'created', '{}', ${now}
FROM interaction_requests
WHERE tenant_id = ${sqlValue(tenantId)} AND idempotency_key = ${sqlValue(input.idempotencyKey.trim())}
  AND NOT EXISTS (
    SELECT 1 FROM interaction_events e
    WHERE e.interaction_id = interaction_requests.id AND e.event_type = 'created'
  );
COMMIT;`);

  const rows = await query<InteractionRow>(
    `SELECT * FROM interaction_requests WHERE tenant_id = ${sqlValue(tenantId)} AND idempotency_key = ${sqlValue(input.idempotencyKey.trim())} LIMIT 1;`,
  );
  if (rows[0]) return fromRow(rows[0]);

  // A recurring workflow may run again while its earlier clarification is
  // still unanswered. The active-source index deliberately coalesces those
  // runs into the existing conversation instead of creating notification
  // spam. BEGIN IMMEDIATE above makes this race-safe across concurrent intake.
  const active = await query<InteractionRow>(`
    SELECT * FROM interaction_requests
    WHERE tenant_id = ${sqlValue(tenantId)} AND user_id = ${sqlValue(userId)}
      AND status IN ('open','answered','resuming')
      AND json_extract(source_json, '$.kind') = ${sqlValue(input.source.kind)}
      AND json_extract(source_json, '$.id') = ${sqlValue(input.source.id)}
    ORDER BY created_at_ms DESC LIMIT 1;
  `);
  if (!active[0]) throw new Error("Interaction was not persisted");
  return fromRow(active[0]);
}

export async function getInteraction(id: string, tenantId = DEFAULT_TENANT): Promise<InteractionRequest | null> {
  const rows = await query<InteractionRow>(
    `SELECT * FROM interaction_requests WHERE id = ${sqlValue(id)} AND tenant_id = ${sqlValue(tenantId)} LIMIT 1;`,
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listInteractions(filter: InteractionListFilter = {}): Promise<InteractionRequest[]> {
  const tenantId = filter.tenantId || DEFAULT_TENANT;
  const clauses = [`tenant_id = ${sqlValue(tenantId)}`];
  if (filter.userId) clauses.push(`user_id = ${sqlValue(filter.userId)}`);
  if (filter.status === "active" || !filter.status) clauses.push("status IN ('open','resuming')");
  else if (filter.status !== "all") clauses.push(`status = ${sqlValue(filter.status)}`);
  if (filter.sourceKind) clauses.push(`json_extract(source_json, '$.kind') = ${sqlValue(filter.sourceKind)}`);
  const limit = Math.max(1, Math.min(200, Number(filter.limit) || 50));
  const rows = await query<InteractionRow>(
    `SELECT * FROM interaction_requests WHERE ${clauses.join(" AND ")} ORDER BY created_at_ms DESC LIMIT ${limit};`,
  );
  return rows.map(fromRow);
}

/**
 * Active (unresolved) interactions for a workflow source. Used to decide
 * whether a paused cron schedule may be re-enabled: it must not be while the
 * source still has an open/answered/resuming question.
 */
export async function findActiveInteractionsForSource(
  source: { kind: string; id: string },
  tenantId = DEFAULT_TENANT,
): Promise<InteractionRequest[]> {
  const rows = await query<InteractionRow>(`
    SELECT * FROM interaction_requests
    WHERE tenant_id = ${sqlValue(tenantId)}
      AND status IN ('open','answered','resuming')
      AND json_extract(source_json, '$.kind') = ${sqlValue(source.kind)}
      AND json_extract(source_json, '$.id') = ${sqlValue(source.id)}
    ORDER BY created_at_ms DESC;
  `);
  return rows.map(fromRow);
}

export async function answerInteraction(input: {
  id: string;
  answer: string;
  tenantId?: string;
  userId?: string;
  channel?: string;
  externalId?: string | null;
}): Promise<InteractionResolution> {
  const answer = input.answer.trim();
  if (!answer) throw new Error("answer is required");
  if (answer.length > 10_000) throw new Error("answer must be 10000 characters or fewer");
  const tenantId = input.tenantId || DEFAULT_TENANT;
  const userId = input.userId || DEFAULT_USER;
  const responseId = randomUUID();
  const now = Date.now();
  await execute(`
BEGIN IMMEDIATE;
INSERT OR IGNORE INTO interaction_responses (
  id, interaction_id, tenant_id, user_id, answer, channel, external_id, created_at_ms
)
SELECT ${sqlValue(responseId)}, id, tenant_id, ${sqlValue(userId)}, ${sqlValue(answer)},
  ${sqlValue(input.channel || "mission-control")}, ${sqlValue(input.externalId)}, ${now}
FROM interaction_requests
WHERE id = ${sqlValue(input.id)} AND tenant_id = ${sqlValue(tenantId)} AND status = 'open';
UPDATE interaction_requests
SET status = 'answered', answer = ${sqlValue(answer)}, answered_at_ms = ${now},
    updated_at_ms = ${now}, version = version + 1
WHERE id = ${sqlValue(input.id)} AND tenant_id = ${sqlValue(tenantId)} AND status = 'open'
  AND EXISTS (SELECT 1 FROM interaction_responses WHERE id = ${sqlValue(responseId)});
INSERT INTO interaction_events (id, interaction_id, tenant_id, event_type, detail_json, created_at_ms)
SELECT ${sqlValue(randomUUID())}, ${sqlValue(input.id)}, ${sqlValue(tenantId)}, 'answered',
  ${sqlValue(JSON.stringify({ channel: input.channel || "mission-control" }))}, ${now}
WHERE EXISTS (SELECT 1 FROM interaction_responses WHERE id = ${sqlValue(responseId)});
COMMIT;`);

  const interaction = await getInteraction(input.id, tenantId);
  if (!interaction) throw new Error("Interaction not found");
  const response = await query<{ id: string }>(
    `SELECT id FROM interaction_responses WHERE interaction_id = ${sqlValue(input.id)} LIMIT 1;`,
  );
  return { interaction, accepted: response[0]?.id === responseId };
}

export async function transitionInteraction(input: {
  id: string;
  status: Exclude<InteractionStatus, "open" | "answered">;
  tenantId?: string;
  detail?: Record<string, unknown>;
}): Promise<InteractionRequest> {
  const tenantId = input.tenantId || DEFAULT_TENANT;
  const now = Date.now();
  const allowedFrom: Record<string, string> = {
    skipped: "'open'", cancelled: "'open','answered','resuming'", expired: "'open'",
    resuming: "'answered'", completed: "'answered','resuming'", failed: "'answered','resuming'",
  };
  await execute(`
BEGIN IMMEDIATE;
UPDATE interaction_requests SET status = ${sqlValue(input.status)}, updated_at_ms = ${now}, version = version + 1
WHERE id = ${sqlValue(input.id)} AND tenant_id = ${sqlValue(tenantId)}
  AND status IN (${allowedFrom[input.status] || "''"});
INSERT INTO interaction_events (id, interaction_id, tenant_id, event_type, detail_json, created_at_ms)
SELECT ${sqlValue(randomUUID())}, id, tenant_id, ${sqlValue(input.status)},
  ${sqlValue(JSON.stringify(input.detail || {}))}, ${now}
FROM interaction_requests WHERE id = ${sqlValue(input.id)} AND tenant_id = ${sqlValue(tenantId)}
  AND status = ${sqlValue(input.status)} AND updated_at_ms = ${now};
COMMIT;`);
  const interaction = await getInteraction(input.id, tenantId);
  if (!interaction) throw new Error("Interaction not found");
  if (interaction.status !== input.status) throw new Error(`Cannot transition ${interaction.status} to ${input.status}`);
  return interaction;
}

/** Test-only reset for switching the configured database path in one process. */
export function resetInteractionStoreForTests(): void {
  initializedPath = null;
  initPromise = null;
}
