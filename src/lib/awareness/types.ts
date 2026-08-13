/** Provider- and deployment-neutral contracts for Mission Control's awareness loop. */

export type InteractionKind =
  | "clarification"
  | "choice"
  | "approval"
  | "correction"
  | "confirmation"
  | "missing-context";

export type InteractionStatus =
  | "open"
  | "answered"
  | "skipped"
  | "cancelled"
  | "expired"
  | "resuming"
  | "completed"
  | "failed";

export type WorkflowSourceKind =
  | "cron"
  | "task"
  | "email"
  | "integration"
  | "heartbeat"
  | "system";

export type InteractionChoice = {
  id: string;
  label: string;
  value: string;
};

export type WorkflowSource = {
  kind: WorkflowSourceKind;
  id: string;
  label?: string;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  href?: string;
};

export type InteractionRequest = {
  id: string;
  tenantId: string;
  userId: string;
  agentId: string | null;
  kind: InteractionKind;
  status: InteractionStatus;
  title: string;
  question: string;
  context: string | null;
  reason: string | null;
  source: WorkflowSource;
  choices: InteractionChoice[];
  answer: string | null;
  answeredAt: number | null;
  expiresAt: number | null;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  metadata: Record<string, unknown>;
};

export type CreateInteractionInput = {
  tenantId?: string;
  userId?: string;
  agentId?: string | null;
  kind?: InteractionKind;
  title: string;
  question: string;
  context?: string | null;
  reason?: string | null;
  source: WorkflowSource;
  choices?: InteractionChoice[];
  expiresAt?: number | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export type InteractionListFilter = {
  tenantId?: string;
  userId?: string;
  status?: InteractionStatus | "active" | "all";
  sourceKind?: WorkflowSourceKind;
  limit?: number;
};

export type InteractionResolution = {
  interaction: InteractionRequest;
  accepted: boolean;
};

