/**
 * Zod schemas for the automation route group: scheduled jobs (cron), skills
 * (local surfaces + the ClawHub/Skills.sh registry), sub-agents, hooks,
 * tasks, and MCP tool servers.
 *
 * Every route in this group registers something that later runs on its own
 * — a cron job, an installed skill, an enabled hook, a configured MCP
 * server. An unvalidated payload here does not fail one request, it installs
 * a broken or hostile unit of work that fires later, outside any request
 * context where the error would be visible.
 *
 * Action-switch schemas (cron, the local skills surface, the ClawHub
 * registry, hooks, tasks, MCP) are `z.discriminatedUnion("action", [...])`,
 * one literal per known action — the T-02-27 pattern from
 * `src/lib/schemas/integrations.ts` and `src/lib/schemas/accounts.ts`,
 * applied here as T-02-43: an unrecognized action fails schema validation
 * before the handler's switch (and therefore before any
 * cron.add/skills.install/hooks patch/mcp write RPC) is reached. The
 * visible trade-off, already accepted twice in this phase: an unrecognized
 * action now produces Zod's own "Invalid discriminator value" message (with
 * a `details` tree) instead of each route's former hand-written
 * `Unknown action: <value>` string.
 *
 * `/api/subagents` is the one exception in this file — its action field goes
 * through `sanitizeArg(...).toLowerCase()` before the handler's own
 * if/else chain, so a caller-cased action ("Spawn") is accepted today. A
 * literal-discriminant schema would reject that case-folded input before
 * the handler ever ran, silently narrowing accepted input. That route keeps
 * a loose `z.string().optional()` action field (the `src/lib/schemas/gateway.ts`
 * pattern) and relies on its existing, already-safe `else` branch (400,
 * nothing registered) to reject an unrecognized action.
 *
 * Every field other than `action` stays a manual required-in-handler check
 * (no `details`) so pre-migration "X is required" messages are byte-identical
 * — same split as `src/lib/schemas/agents.ts` — EXCEPT the fields called out
 * below, which get a genuinely new format check per this plan's threat
 * register:
 *
 *   - T-02-40 (Tampering): a malformed cron schedule expression, or a
 *     hook name/env value past its bound, is rejected here — before
 *     cron.add/cron.update or a hooks config patch ever registers a unit of
 *     work that would then fail (or misbehave) silently at fire time.
 *   - T-02-39 (Elevation of Privilege): an MCP server's `url` is constrained
 *     to a parsed absolute URL with an allowed scheme set at the point it is
 *     written (`POST /api/mcp` create/update) — before it is ever persisted
 *     to config and later read back by `GET /api/mcp/probe`, so a caller
 *     cannot use this app as a proxy to probe an arbitrary destination.
 *   - T-02-41 (Denial of Service): the tasks route's existing task/flow id
 *     bound (`MAX_TASK_ID_LENGTH`) is ported into the schema one-for-one, and
 *     its existing body-size constant is exported here for the wrapper's
 *     `maxBytes` option, so neither guard is dropped by the migration.
 */
import { z } from "zod";

// ── POST /api/cron ─────────────────────────────────────────────────────────

const cronActionLiterals = ["enable", "disable", "run", "delete", "edit", "create"] as const;

const cronActionVariants = cronActionLiterals.map((action) =>
  z.object({ action: z.literal(action) }).passthrough(),
) as [
  z.ZodObject<{ action: z.ZodLiteral<(typeof cronActionLiterals)[number]> }>,
  ...z.ZodObject<{ action: z.ZodLiteral<(typeof cronActionLiterals)[number]> }>[],
];

/**
 * Standard 5-field crontab syntax (minute hour day-of-month month
 * day-of-week) — the format the OpenClaw scheduler already accepts (see the
 * "0 8 * * *" default in `src/components/cron-view.tsx`). Each field is `*`
 * or a bounded list of digits/ranges/steps — never arbitrary text.
 */
const CRON_FIELD_SOURCE = "(\\*|[0-9]+)(-[0-9]+)?(\\/[0-9]+)?(,(\\*|[0-9]+)(-[0-9]+)?(\\/[0-9]+)?)*";
export const CRON_EXPRESSION_PATTERN = new RegExp(`^${CRON_FIELD_SOURCE}(\\s+${CRON_FIELD_SOURCE}){4}$`);
export const CRON_EXPRESSION_MAX_LENGTH = 120;
export const CRON_EXPRESSION_MESSAGE =
  'Cron expression must be 5 space-separated fields (minute hour day month weekday), e.g. "0 8 * * *".';

function isMalformedCronExpression(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CRON_EXPRESSION_MAX_LENGTH) return true;
  return !CRON_EXPRESSION_PATTERN.test(trimmed);
}

export const cronPostSchema = z
  .discriminatedUnion("action", cronActionVariants)
  .superRefine((value, ctx) => {
    const body = value as Record<string, unknown>;
    if (
      value.action === "create" &&
      body.scheduleKind === "cron" &&
      typeof body.cronExpr === "string" &&
      body.cronExpr.trim() &&
      isMalformedCronExpression(body.cronExpr)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CRON_EXPRESSION_MESSAGE, path: ["cronExpr"] });
    }
    if (
      value.action === "edit" &&
      typeof body.cron === "string" &&
      body.cron.trim() &&
      isMalformedCronExpression(body.cron)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CRON_EXPRESSION_MESSAGE, path: ["cron"] });
    }
  });
export type CronPostInput = z.infer<typeof cronPostSchema>;

export const cronGetQuerySchema = z
  .object({
    action: z.string().optional(),
    id: z.string().optional(),
    limit: z.string().optional(),
    requestedAt: z.string().optional(),
    baselineRunAt: z.string().optional(),
  })
  .passthrough();
export type CronGetQuery = z.infer<typeof cronGetQuerySchema>;

// ── GET/POST /api/skills (local inventory surface) ──────────────────────────

const skillsActionLiterals = ["install-requirement", "enable-skill", "disable-skill", "update-tool-config"] as const;

const skillsActionVariants = skillsActionLiterals.map((action) =>
  z.object({ action: z.literal(action) }).passthrough(),
) as [
  z.ZodObject<{ action: z.ZodLiteral<(typeof skillsActionLiterals)[number]> }>,
  ...z.ZodObject<{ action: z.ZodLiteral<(typeof skillsActionLiterals)[number]> }>[],
];

export const skillsPostSchema = z.discriminatedUnion("action", skillsActionVariants);
export type SkillsPostInput = z.infer<typeof skillsPostSchema>;

export const skillsGetQuerySchema = z
  .object({
    action: z.string().optional(),
    agent: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();
export type SkillsGetQuery = z.infer<typeof skillsGetQuerySchema>;

// ── GET/POST /api/skills/clawhub (ClawHub + Skills.sh registry) ─────────────

const skillsClawhubActionLiterals = ["install", "update", "uninstall"] as const;

const skillsClawhubActionVariants = skillsClawhubActionLiterals.map((action) =>
  z.object({ action: z.literal(action) }).passthrough(),
) as [
  z.ZodObject<{ action: z.ZodLiteral<(typeof skillsClawhubActionLiterals)[number]> }>,
  ...z.ZodObject<{ action: z.ZodLiteral<(typeof skillsClawhubActionLiterals)[number]> }>[],
];

export const skillsClawhubPostSchema = z.discriminatedUnion("action", skillsClawhubActionVariants);
export type SkillsClawhubPostInput = z.infer<typeof skillsClawhubPostSchema>;

export const skillsClawhubGetQuerySchema = z
  .object({
    action: z.string().optional(),
    q: z.string().optional(),
    limit: z.string().optional(),
    slug: z.string().optional(),
    sort: z.string().optional(),
  })
  .passthrough();
export type SkillsClawhubGetQuery = z.infer<typeof skillsClawhubGetQuerySchema>;

// ── POST /api/skills/test ────────────────────────────────────────────────────
//
// `skillName`/`agentId` already go through the route's own `safeToken()`
// (format regex + empty-string fallback semantics) — that fallback logic
// decides whether a malformed token becomes "missing" (then a manual
// required-field 400) or is silently replaced with a default. Duplicating
// the format regex here would risk a different accept/reject outcome than
// the handler's fallback produces, so this schema only guards the type.

export const skillsTestPostSchema = z
  .object({
    skillName: z.string().optional(),
    agentId: z.string().optional(),
    input: z.string().optional(),
  })
  .passthrough();
export type SkillsTestPostInput = z.infer<typeof skillsTestPostSchema>;

// ── GET/POST /api/subagents ───────────────────────────────────────────────
//
// See the file-level note: action stays a loose optional string because the
// handler case-folds it (`sanitizeArg(...).toLowerCase()`) before comparing.

export const subagentsPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type SubagentsPostInput = z.infer<typeof subagentsPostSchema>;

export const subagentsGetQuerySchema = z
  .object({
    agentId: z.string().optional(),
    sessionKey: z.string().optional(),
  })
  .passthrough();
export type SubagentsGetQuery = z.infer<typeof subagentsGetQuerySchema>;

// ── GET/POST /api/hooks ──────────────────────────────────────────────────

export const HOOK_NAME_MAX_LENGTH = 200;
export const HOOK_ENV_KEY_MAX_LENGTH = 200;
export const HOOK_ENV_VALUE_MAX_LENGTH = 4000;

const hookNameField = z.string().max(HOOK_NAME_MAX_LENGTH).optional();

const hooksEnableHookAction = z.object({ action: z.literal("enable-hook"), name: hookNameField }).passthrough();
const hooksDisableHookAction = z.object({ action: z.literal("disable-hook"), name: hookNameField }).passthrough();
const hooksEnableAllAction = z
  .object({ action: z.literal("enable-all"), names: z.array(z.string().max(HOOK_NAME_MAX_LENGTH)).optional() })
  .passthrough();
const hooksToggleSystemAction = z
  .object({ action: z.literal("toggle-system"), enabled: z.boolean().optional() })
  .passthrough();
const hooksUpdateHookEnvAction = z
  .object({
    action: z.literal("update-hook-env"),
    name: hookNameField,
    env: z.record(z.string().max(HOOK_ENV_KEY_MAX_LENGTH), z.string().max(HOOK_ENV_VALUE_MAX_LENGTH)).optional(),
  })
  .passthrough();

export const hooksPostSchema = z.discriminatedUnion("action", [
  hooksEnableHookAction,
  hooksDisableHookAction,
  hooksEnableAllAction,
  hooksToggleSystemAction,
  hooksUpdateHookEnvAction,
]);
export type HooksPostInput = z.infer<typeof hooksPostSchema>;

export const hooksGetQuerySchema = z
  .object({
    action: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();
export type HooksGetQuery = z.infer<typeof hooksGetQuerySchema>;

// ── GET/POST /api/tasks ──────────────────────────────────────────────────
//
// Ports `validateTaskId`/`MAX_TASK_ID_LENGTH` from the pre-migration route
// one-for-one: same bound, same "Invalid id" message. `MAX_TASKS_BODY_BYTES`
// is exported so the route passes it through to `withRoute`'s `maxBytes`
// option instead of losing the size guard during migration (T-02-41).

export const TASK_ID_MAX_LENGTH = 512;
export const TASKS_MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const TASK_ID_MESSAGE = "Invalid id";

function isValidTaskId(value: unknown): value is string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 && raw.length <= TASK_ID_MAX_LENGTH;
}

const taskIdField = z
  .custom<string>(isValidTaskId, { message: TASK_ID_MESSAGE })
  .transform((value) => value.trim());

const tasksCancelAction = z.object({ action: z.literal("cancel"), id: taskIdField }).passthrough();
const tasksCancelFlowAction = z.object({ action: z.literal("cancel-flow"), id: taskIdField }).passthrough();
const tasksNotifyAction = z
  .object({ action: z.literal("notify"), id: taskIdField, policy: z.string().optional() })
  .passthrough();
const tasksMaintenanceApplyAction = z.object({ action: z.literal("maintenance-apply") }).passthrough();

export const tasksPostSchema = z.discriminatedUnion("action", [
  tasksCancelAction,
  tasksCancelFlowAction,
  tasksNotifyAction,
  tasksMaintenanceApplyAction,
]);
export type TasksPostInput = z.infer<typeof tasksPostSchema>;

// ── POST /api/mcp ─────────────────────────────────────────────────────────
//
// `server.url` (the tool-server's outbound endpoint) is constrained to a
// parsed absolute URL with an allowed scheme set (T-02-39) — checked here,
// at write time, before `saveServer` ever persists it to
// `~/.openclaw/openclaw.json` → `mcp.servers` where `GET /api/mcp/probe`
// (and the gateway's own MCP client) would later read it back and connect.
// A stdio server (no `url`) and an http/sse server that simply omits `url`
// are untouched — that "needs a URL" case stays the route's existing
// required-field runtime check (`src/lib/mcp.ts#buildConfig`).

export const MCP_ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
export const MCP_SERVER_URL_MAX_LENGTH = 2048;
export const MCP_SERVER_URL_MESSAGE = "Server URL must be an absolute http:// or https:// address.";

export function isAllowedMcpServerUrl(value: string): boolean {
  if (!value || value.length > MCP_SERVER_URL_MAX_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return MCP_ALLOWED_URL_SCHEMES.has(parsed.protocol);
}

const mcpCreateAction = z.object({ action: z.literal("create"), server: z.unknown().optional() }).passthrough();
const mcpUpdateAction = z.object({ action: z.literal("update"), server: z.unknown().optional() }).passthrough();
const mcpEnableAction = z.object({ action: z.literal("enable") }).passthrough();
const mcpDisableAction = z.object({ action: z.literal("disable") }).passthrough();
const mcpToolsAction = z.object({ action: z.literal("tools") }).passthrough();
const mcpRemoveAction = z.object({ action: z.literal("remove") }).passthrough();
const mcpLoginAction = z.object({ action: z.literal("login") }).passthrough();
const mcpLogoutAction = z.object({ action: z.literal("logout") }).passthrough();

export const mcpPostSchema = z
  .discriminatedUnion("action", [
    mcpCreateAction,
    mcpUpdateAction,
    mcpEnableAction,
    mcpDisableAction,
    mcpToolsAction,
    mcpRemoveAction,
    mcpLoginAction,
    mcpLogoutAction,
  ])
  .superRefine((value, ctx) => {
    if (value.action !== "create" && value.action !== "update") return;
    const server = value.server;
    if (!server || typeof server !== "object") return;
    const record = server as Record<string, unknown>;
    const transport = typeof record.transport === "string" ? record.transport : undefined;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (transport === "stdio" || !url) return;
    if (!isAllowedMcpServerUrl(url)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MCP_SERVER_URL_MESSAGE, path: ["server", "url"] });
    }
  });
export type McpPostInput = z.infer<typeof mcpPostSchema>;
