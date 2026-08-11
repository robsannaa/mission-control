/**
 * Client-side mirrors of the G-Brain API shapes (src/lib/gbrain.ts,
 * src/app/api/g-brain/route.ts). Kept in sync by hand — this is a thin
 * UI-only facade, not a shared package.
 */

export type GbrainArg = {
  name: string;
  flag?: string;
  placeholder?: string;
  required?: boolean;
};

export type GbrainCategory =
  | "overview"
  | "auto-jobs"
  | "search"
  | "pages"
  | "links"
  | "tags"
  | "timeline"
  | "sources"
  | "files"
  | "code"
  | "brain"
  | "maintenance"
  | "integration";

export type GbrainCommand = {
  id: string;
  label: string;
  category: GbrainCategory;
  description: string;
  args?: GbrainArg[];
  mutates?: boolean;
  dangerous?: boolean;
  json?: boolean;
};

export type DoctorCheck = {
  name: string;
  status: string;
  message: string;
  category?: string;
};

export type Doctor = {
  status?: string;
  health_score?: number;
  category_scores?: Record<string, number>;
  checks?: DoctorCheck[];
  top_issues?: { name: string; status: string; fix: string }[];
};

export type Overview = {
  installed: boolean;
  detection?: { engine?: string; schemaPack?: string; home?: string };
  doctor?: Doctor | null;
  doctorError?: string | null;
  stats?: string;
  jobs?: string;
  jobsError?: string | null;
  health?: string;
};

export type DreamPhase = {
  phase: string;
  status: string;
  duration_ms?: number;
  summary?: string;
  details?: Record<string, unknown>;
};

export type DreamResult = {
  schema_version?: string | number;
  timestamp?: string;
  duration_ms?: number;
  status?: string;
  phases?: DreamPhase[];
  totals?: Record<string, number>;
};

/** Result of a POST /api/g-brain call. */
export type RunResult = {
  ok: boolean;
  stdout: string;
  json?: unknown;
  error?: string;
  needsConfirm?: boolean;
  argv?: string[];
};
