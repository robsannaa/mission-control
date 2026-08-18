"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { requestRestart } from "@/lib/restart-store";
import {
  ChevronDown,
  ChevronRight,
  Save,
  AlertCircle,
  CheckCircle,
  Shield,
  RefreshCw,
  Eye,
  EyeOff,
  Search,
  X,
  Plus,
  Trash2,
  RotateCcw,
  AlertTriangle,
  Info,
  Code,
  Settings2,
  GripVertical,
  ListMinus,
  Lock,
  Sparkles,
  Variable,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { applyMergePatch, buildConfigDiff, type JsonObject } from "@/lib/config-diff";
// The validator MUST come from config-schema-validate: config-schema-lookup
// re-exports it but also pulls in the gateway transport (child_process/fs),
// which must never reach a client bundle.
import {
  validateConfigValue,
  type NormalizedConfigLookup,
} from "@/lib/config-schema-validate";
import {
  ConfigLookupContext,
  useConfigLookupSource,
  useFieldLookup,
} from "@/hooks/use-config-lookup";
import {
  analyzeConflict,
  buildFieldIndex,
  buildSaveBody,
  deleteAtPath,
  describeChanges,
  detectAuthTokenMint,
  getAtPath,
  isEnvSubstitutedPath,
  isSensitiveConfigPath,
  planRestart,
  searchFields,
  setAtPath,
  type ChangeEntry,
  type FieldIndexEntry,
} from "@/components/config/config-changes";
import {
  fetchConfigPayload,
  runDoctor,
  saveConfig,
  type DoctorReport,
  type SaveSuccess,
} from "@/components/config/config-api";
import { ConfigDiffPreview } from "@/components/config/config-diff-preview";
import { ConfigConflictDialog } from "@/components/config/config-conflict-dialog";
import {
  ConfigErrorPanel,
  type ConfigErrorDetail,
} from "@/components/config/config-error-panel";
import { ConfigDoctorPanel } from "@/components/config/config-doctor-panel";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.default),
  { ssr: false, loading: () => <div className="flex h-1/2 min-h-48 items-center justify-center rounded-lg bg-muted/60 font-mono text-xs text-muted-foreground">Loading editor…</div> }
);

/* ================================================================
   Types
   ================================================================ */

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  propertyNames?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: string[];
  const?: unknown;
  default?: unknown;
  minLength?: number;
  description?: string;
  $schema?: string;
};

type UiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  sensitive?: boolean;
  enum?: string[];
  placeholder?: string;
};

type Toast = { ok: boolean; msg: string };

/* ================================================================
   Section metadata (icons + ordering)
   ================================================================ */

const SECTION_ICONS: Record<string, string> = {
  gateway: "🌐",
  channels: "💬",
  agents: "🤖",
  models: "🧠",
  env: "🔑",
  auth: "🔐",
  tools: "🔧",
  bindings: "🔗",
  messages: "✉️",
  commands: "⌘",
  hooks: "🪝",
  skills: "⚡",
  plugins: "🔌",
  browser: "🌍",
  talk: "🗣️",
  meta: "📋",
  wizard: "🧙",
  session: "📍",
  cron: "⏰",
  ui: "🎨",
  discovery: "📡",
  canvasHost: "🖼️",
  audio: "🔊",
  media: "🎬",
  memory: "💾",
  approvals: "✅",
  nodeHost: "🖥️",
  broadcast: "📢",
  update: "🔄",
  diagnostics: "🩺",
  logging: "📝",
  web: "🕸️",
  presence: "👁️",
  voicewake: "🎤",
};

/**
 * Sections Mission Control and the OpenClaw wizard write for themselves.
 *
 * These used to be flagged `READONLY_SECTIONS` and rendered with disabled
 * inputs — pure theater: `PATCH /api/config` has always written them, and the
 * Raw tab never honoured the flag either. Claiming a lock that does not exist
 * is exactly the kind of quiet lie this editor is being fixed to stop, so they
 * are now editable and honestly labelled instead.
 */
const MANAGED_SECTIONS = new Set(["meta", "wizard", "diagnostics"]);
const SENSITIVE_SECTIONS = new Set(["env", "auth"]);

/** Default order for group names in the sidebar */
const GROUP_ORDER = [
  "Core",
  "Gateway",
  "Agents",
  "Channels",
  "Models",
  "Security",
  "Tools",
  "Voice & Audio",
  "Advanced",
  "General",
];

/* ================================================================
   Helpers
   ================================================================ */

/** Get the label for a config path from hints */
export function getLabel(
  hints: Record<string, UiHint>,
  path: string,
  fallback: string
): string {
  return hints[path]?.label || fallback;
}

export function getHelp(hints: Record<string, UiHint>, path: string): string {
  return hints[path]?.help || "";
}

export function isSensitivePath(hints: Record<string, UiHint>, path: string): boolean {
  return isSensitiveConfigPath(hints, path);
}

/** Infer field type from JSON Schema */
export function inferFieldType(
  schema: JsonSchema | undefined,
  hint: UiHint | undefined
): "string" | "number" | "boolean" | "array" | "object" | "enum" | "unknown" {
  if (hint?.enum && hint.enum.length > 0) return "enum";
  if (schema?.enum && schema.enum.length > 0) return "enum";
  if (schema?.const !== undefined) return "enum";
  if (schema?.anyOf || schema?.oneOf) {
    const variants = schema.anyOf || schema.oneOf || [];
    // Check if it's an enum-like anyOf (all const/enum)
    const isEnumLike = variants.every(
      (v) => v.const !== undefined || (v.enum && v.enum.length > 0) || v.type === "string"
    );
    if (isEnumLike && variants.length <= 10) return "enum";
  }
  switch (schema?.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
  }
  return "unknown";
}

/** Extract enum values from schema */
export function extractEnumValues(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  if (schema.enum) return schema.enum;
  if (schema.const !== undefined) return [String(schema.const)];
  if (schema.anyOf || schema.oneOf) {
    const vals: string[] = [];
    for (const v of schema.anyOf || schema.oneOf || []) {
      if (v.const !== undefined) vals.push(String(v.const));
      if (v.enum) vals.push(...v.enum);
    }
    return vals;
  }
  return [];
}

/**
 * Seed a value for a field that has never been configured, so "Set up" lands
 * the user on a usable control instead of an empty JSON blob.
 */
export function emptyValueForType(fieldType: string, schema: JsonSchema | undefined): unknown {
  switch (fieldType) {
    case "string":
    case "enum":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return schema?.type === "array" ? [] : "";
  }
}

/* ================================================================
   Toast — success only. Failures get a persistent panel.
   ================================================================ */

function ToastBar({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className={cn(
        "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-xl backdrop-blur-sm",
        toast.ok
          ? "border-emerald-500/30 bg-emerald-950/80 text-emerald-300"
          : "border-red-500/30 bg-red-950/80 text-red-300"
      )}
    >
      <div className="flex items-center gap-2">
        {toast.ok ? (
          <CheckCircle className="h-4 w-4" />
        ) : (
          <AlertCircle className="h-4 w-4" />
        )}
        {toast.msg}
      </div>
    </div>
  );
}

/* ================================================================
   Field environment — everything a deeply nested field needs without
   threading eight props through five levels of recursion.
   ================================================================ */

type FieldEnv = {
  hints: Record<string, UiHint>;
  showSensitive: boolean;
  envSubstituted: string[];
  reportValidity: (path: string, message: string | null) => void;
  onDelete: (path: string) => void;
  highlightPath: string | null;
};

const FieldEnvContext = createContext<FieldEnv>({
  hints: {},
  showSensitive: false,
  envSubstituted: [],
  reportValidity: () => {},
  onDelete: () => {},
  highlightPath: null,
});

function useFieldEnv(): FieldEnv {
  return useContext(FieldEnvContext);
}

/* ================================================================
   Field Renderers
   ================================================================ */

function FieldLabel({
  label,
  help,
  sensitive,
  required,
}: {
  label: string;
  help?: string;
  sensitive?: boolean;
  required?: boolean;
}) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5">
        <label className="text-xs font-medium text-foreground/70">
          {label}
          {required && <span className="text-red-400 ml-0.5">*</span>}
        </label>
        {sensitive && (
          <Shield className="h-3 w-3 text-amber-500" />
        )}
      </div>
      {help && (
        <p className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed">
          {help}
        </p>
      )}
    </div>
  );
}

/** Small badge row: what the gateway's schema says about this field. */
function FieldBadges({
  lookup,
  envLocked,
}: {
  lookup: NormalizedConfigLookup | null | undefined;
  envLocked: boolean;
}) {
  const badges: React.ReactNode[] = [];
  if (lookup?.reloadKind === "restart") {
    badges.push(
      <span
        key="restart"
        title={
          lookup.reloadKindSource === "matrix"
            ? "Documented reload table says this restarts the gateway."
            : "The gateway reports that this path needs a restart."
        }
        className="inline-flex items-center gap-1 rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:text-orange-300"
      >
        <RefreshCw className="h-2.5 w-2.5" />
        restarts gateway
      </span>
    );
  }
  if (lookup?.deprecated) {
    badges.push(
      <span
        key="deprecated"
        className="rounded border border-foreground/15 bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      >
        deprecated
      </span>
    );
  }
  if (lookup?.readOnly) {
    badges.push(
      <span
        key="readonly"
        className="rounded border border-foreground/15 bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      >
        read-only
      </span>
    );
  }
  if (envLocked) {
    badges.push(
      <span
        key="env"
        className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300"
      >
        <Variable className="h-2.5 w-2.5" />
        from environment
      </span>
    );
  }
  if (badges.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1">{badges}</div>;
}

/**
 * Everything shared by every field: schema lookup, live validation, the
 * restart/deprecated/env badges, a real delete button, and the anchor that
 * makes "jump to field" work from search.
 */
function FieldShell({
  path,
  label,
  help,
  value,
  exists,
  sensitive,
  disabled,
  children,
}: {
  path: string;
  label: string;
  help?: string;
  value: unknown;
  /** True when the key is present in the document (so it can be removed). */
  exists: boolean;
  sensitive: boolean;
  disabled: boolean;
  children: (opts: { disabled: boolean }) => React.ReactNode;
}) {
  const env = useFieldEnv();
  const { reportValidity, onDelete, highlightPath } = env;
  const lookup = useFieldLookup(path);
  const [envUnlocked, setEnvUnlocked] = useState(false);

  const envSubstituted = isEnvSubstitutedPath(env.envSubstituted, path);
  const envLocked = envSubstituted && !envUnlocked;

  // A field that has never been configured is not part of this write, so a
  // `required` rule on it is not the operator's problem yet — validating it
  // would block every save on an untouched optional section.
  const inPlay = exists || value !== undefined;
  const validation = useMemo(
    () => (inPlay ? validateConfigValue(lookup, value) : { ok: true as const }),
    [inPlay, lookup, value]
  );
  const message = validation.ok ? null : validation.message;

  useEffect(() => {
    reportValidity(path, message);
    return () => reportValidity(path, null);
  }, [path, message, reportValidity]);

  const highlighted = highlightPath === path;

  return (
    <div
      id={`cfg-field-${path}`}
      data-config-path={path}
      className={cn(
        "space-y-1 scroll-mt-24 rounded-lg transition-colors",
        highlighted && "bg-emerald-500/10 ring-1 ring-emerald-500/40 -mx-2 px-2 py-1.5"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <FieldLabel
            label={label}
            help={help || lookup?.help}
            sensitive={sensitive}
            required={lookup?.required === true}
          />
        </div>
        {exists && !disabled && (
          <button
            type="button"
            onClick={() => onDelete(path)}
            title={`Remove ${label} from the configuration`}
            aria-label={`Remove ${path}`}
            data-testid="field-remove"
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:bg-red-500/10 hover:text-red-500"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      <FieldBadges lookup={lookup} envLocked={envSubstituted} />

      {children({ disabled: disabled || envLocked })}

      {envLocked && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-sky-700 dark:text-sky-300">
          <Lock className="h-3 w-3" />
          This value resolves from the environment at runtime.
          <button
            type="button"
            onClick={() => setEnvUnlocked(true)}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Edit anyway
          </button>
        </p>
      )}
      {envSubstituted && envUnlocked && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Replacing <code className="font-mono">${"{VAR}"}</code> with a literal value removes the
          environment indirection permanently.
        </p>
      )}

      {message && (
        <p
          role="alert"
          data-testid="field-error"
          className="flex items-start gap-1.5 text-xs font-medium text-red-600 dark:text-red-400"
        >
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {message}
        </p>
      )}
    </div>
  );
}

function StringField({
  value,
  onChange,
  placeholder,
  sensitive,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  sensitive?: boolean;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(!sensitive);
  const inputType = sensitive ? (show ? "text" : "password") : "text";
  return (
    <div className="flex items-center gap-1">
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder || ""}
        className="flex-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-900 outline-none transition-colors focus:border-emerald-500/30 disabled:opacity-50 font-mono dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
      />
      {sensitive && (
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="rounded p-1 text-muted-foreground/60 hover:text-muted-foreground"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

function NumberField({
  value,
  onChange,
  disabled,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? undefined : Number(v));
      }}
      disabled={disabled}
      className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-900 outline-none transition-colors focus:border-emerald-500/30 disabled:opacity-50 font-mono dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
    />
  );
}

function BooleanField({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className={cn(
        "relative h-6 w-11 rounded-full transition-colors",
        value ? "bg-primary" : "bg-muted",
        disabled && "opacity-50"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
          value ? "left-6" : "left-0.5"
        )}
      />
    </button>
  );
}

function EnumField({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  // For 2-4 options use buttons, for more use select
  if (options.length <= 5) {
    return (
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => !disabled && onChange(opt)}
            disabled={disabled}
            className={cn(
              "rounded border px-2 py-1 text-xs font-medium transition-all",
              value === opt
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-stone-200 bg-stone-50 text-stone-500 hover:border-stone-300 hover:text-stone-900 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#a8b0ba] dark:hover:text-[#f5f7fa]"
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="rounded-lg border border-foreground/10 bg-muted px-3 py-1.5 text-xs text-foreground/90 outline-none"
    >
      <option value="">Select...</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function ArrayField({
  value,
  onChange,
  itemSchema,
  disabled,
}: {
  value: unknown[];
  onChange: (v: unknown[]) => void;
  itemSchema?: JsonSchema;
  disabled?: boolean;
}) {
  const isStringArray = !itemSchema || itemSchema.type === "string";

  const addItem = () => {
    onChange([...value, ""]);
  };

  const removeItem = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, v: unknown) => {
    const next = [...value];
    next[idx] = v;
    onChange(next);
  };

  if (!isStringArray) {
    return (
      <GenericArrayEditor
        value={value}
        onChange={(v) => onChange(Array.isArray(v) ? v : [v])}
        disabled={disabled}
        depth={0}
      />
    );
  }

  return (
    <div className="space-y-1.5">
      {value.map((item, idx) => (
        <div key={idx} className="flex items-center gap-1.5">
          <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground/40" />
          <input
            type="text"
            value={String(item)}
            onChange={(e) => updateItem(idx, e.target.value)}
            disabled={disabled}
            className="flex-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-900 outline-none font-mono focus:border-emerald-500/30 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
          />
          {!disabled && (
            <button
              type="button"
              onClick={() => removeItem(idx)}
              className="rounded p-1 text-muted-foreground/60 hover:text-red-400 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={addItem}
          className="flex items-center gap-1 rounded-lg border border-dashed border-stone-200 px-3 py-1.5 text-xs text-stone-500 transition-colors hover:border-emerald-500/30 hover:text-emerald-700 dark:border-[#2c343d] dark:text-[#a8b0ba] dark:hover:text-emerald-300"
        >
          <Plus className="h-3 w-3" />
          Add item
        </button>
      )}
    </div>
  );
}

/** Detect config shape { primary?: string, fallbacks?: string[] } for model defaults */
function isModelPrimaryFallbacksShape(value: unknown): value is { primary?: string; fallbacks?: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const hasPrimary = !("primary" in o) || typeof o.primary === "string";
  const hasFallbacks = !("fallbacks" in o) || (Array.isArray(o.fallbacks) && o.fallbacks.every((f) => typeof f === "string"));
  return hasPrimary && hasFallbacks && (Object.keys(o).length <= 2 || ("primary" in o && "fallbacks" in o));
}

/** UI for primary model + reorderable fallbacks (drag-and-drop). No raw JSON. */
function ModelPrimaryFallbacksEditor({
  path,
  value,
  hints,
  onFieldChange,
  disabled,
}: {
  path: string;
  value: { primary?: string; fallbacks?: string[] };
  hints: Record<string, UiHint>;
  onFieldChange: (path: string, value: unknown) => void;
  disabled: boolean;
}) {
  const primary = typeof value.primary === "string" ? value.primary : "";
  const fallbacks = useMemo(
    () => (Array.isArray(value.fallbacks) ? value.fallbacks.map((f) => String(f)) : []),
    [value.fallbacks]
  );
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const update = useCallback(
    (next: { primary: string; fallbacks: string[] }) => {
      onFieldChange(path, next);
    },
    [path, onFieldChange]
  );

  const setPrimary = useCallback(
    (v: string) => {
      update({ primary: v, fallbacks });
    },
    [update, fallbacks]
  );

  const setFallbacks = useCallback(
    (next: string[]) => {
      update({ primary, fallbacks: next });
    },
    [update, primary]
  );

  const addFallback = () => setFallbacks([...fallbacks, ""]);
  const removeFallback = (idx: number) => setFallbacks(fallbacks.filter((_, i) => i !== idx));
  const updateFallback = (idx: number, v: string) => {
    const next = [...fallbacks];
    next[idx] = v;
    setFallbacks(next);
  };

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDraggedIndex(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
    e.dataTransfer.setData("application/json", JSON.stringify({ index: idx }));
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const handleDragEnd = () => setDraggedIndex(null);
  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    setDraggedIndex(null);
    const from = draggedIndex ?? parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (Number.isNaN(from) || from === targetIdx) return;
    const next = [...fallbacks];
    const [removed] = next.splice(from, 1);
    next.splice(targetIdx, 0, removed);
    setFallbacks(next);
  };

  const primaryLabel = getLabel(hints, `${path}.primary`, "Primary Model");
  const primaryHelp = getHelp(hints, `${path}.primary`);
  const fallbacksLabel = getLabel(hints, `${path}.fallbacks`, "Model Fallbacks");
  const fallbacksHelp = getHelp(hints, `${path}.fallbacks`);

  const options = Array.from(
    new Set([primary, ...fallbacks].filter((s): s is string => Boolean(s)))
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <FieldLabel label={primaryLabel} help={primaryHelp} />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
            disabled={disabled}
            className="rounded border border-stone-200 bg-stone-50 px-2 py-1 text-xs text-stone-900 outline-none focus:border-emerald-500/30 font-mono min-w-44 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
          >
            {options.length === 0 && (
              <option value="">Select or type below…</option>
            )}
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={options.includes(primary) ? "" : primary}
            onChange={(e) => setPrimary(e.target.value.trim() || primary)}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && !options.includes(v)) setPrimary(v);
            }}
            disabled={disabled}
            placeholder="Or type provider/model…"
            className="rounded border border-stone-200 bg-stone-50 px-2 py-1 text-xs text-stone-900 outline-none font-mono focus:border-emerald-500/30 w-56 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
          />
        </div>
      </div>

      <div className="space-y-1">
        <FieldLabel label={fallbacksLabel} help={fallbacksHelp} />
        <div className="space-y-1">
          {fallbacks.map((item, idx) => (
            <div
              key={idx}
              draggable={!disabled}
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(e, idx)}
              className={cn(
                "flex items-center gap-2 rounded border border-foreground/10 bg-muted/50 py-1 pr-1",
                draggedIndex === idx && "opacity-50"
              )}
            >
              {!disabled && (
                <button
                  type="button"
                  className="cursor-grab active:cursor-grabbing p-1.5 text-muted-foreground/60 hover:text-foreground/70 touch-none"
                  aria-label="Drag to reorder"
                  onPointerDown={(e) => e.preventDefault()}
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </button>
              )}
              <input
                type="text"
                value={item}
                onChange={(e) => updateFallback(idx, e.target.value)}
                disabled={disabled}
                className="flex-1 min-w-0 rounded border-0 bg-transparent px-2 py-1 text-xs font-mono text-foreground/90 outline-none"
              />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeFallback(idx)}
                  className="rounded p-1 text-muted-foreground/60 hover:text-red-400 transition-colors"
                  aria-label="Remove"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {!disabled && (
            <button
              type="button"
              onClick={addFallback}
              className="flex items-center gap-1 rounded border border-dashed border-stone-200 px-2 py-1.5 text-xs text-stone-500 transition-colors hover:border-emerald-500/30 hover:text-emerald-700 dark:border-[#2c343d] dark:text-[#a8b0ba] dark:hover:text-emerald-300"
            >
              <Plus className="h-3 w-3" />
              Add fallback
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const MAX_GENERIC_EDITOR_DEPTH = 10;

/** Shown when nesting is too deep; edit in Raw tab. */
function FormViewEditInRawPlaceholder() {
  return (
    <div className="rounded-lg border border-dashed border-foreground/15 bg-muted/40 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Too deep to edit here. Use the <strong className="text-foreground/70">Raw</strong> tab to edit.
      </p>
    </div>
  );
}

/** Single value editor by type (string / number / boolean / object / array). Used inside generic object/array editors. */
function GenericValueEditor({
  value,
  onChange,
  disabled,
  depth,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  depth: number;
}) {
  if (depth >= MAX_GENERIC_EDITOR_DEPTH) {
    return <FormViewEditInRawPlaceholder />;
  }
  if (value === null || value === undefined) {
    return (
      <input
        type="text"
        placeholder="string"
        value=""
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={disabled}
        className="flex-1 min-w-0 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-900 outline-none font-mono focus:border-emerald-500/30 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
      />
    );
  }
  if (typeof value === "string") {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="flex-1 min-w-0 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-900 outline-none font-mono focus:border-emerald-500/30 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
      />
    );
  }
  if (typeof value === "number") {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        disabled={disabled}
        className="flex-1 min-w-0 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-900 outline-none font-mono focus:border-emerald-500/30 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
      />
    );
  }
  if (typeof value === "boolean") {
    return (
      <button
        type="button"
        onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        className={cn(
          "relative h-6 w-11 rounded-full transition-colors shrink-0",
          value ? "bg-primary" : "bg-muted",
          disabled && "opacity-50"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            value ? "left-6" : "left-0.5"
          )}
        />
      </button>
    );
  }
  if (Array.isArray(value)) {
    return (
      <GenericArrayEditor
        value={value}
        onChange={onChange}
        disabled={disabled}
        depth={depth + 1}
      />
    );
  }
  if (typeof value === "object" && value !== null) {
    return (
      <GenericObjectEditor
        value={value as Record<string, unknown>}
        onChange={onChange}
        disabled={disabled}
        depth={depth + 1}
      />
    );
  }
  return <FormViewEditInRawPlaceholder />;
}

/** Object as key-value list: add/remove/edit keys and values. */
function GenericObjectEditor({
  value,
  onChange,
  disabled,
  depth,
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  disabled?: boolean;
  depth: number;
}) {
  if (depth >= MAX_GENERIC_EDITOR_DEPTH) {
    return <FormViewEditInRawPlaceholder />;
  }
  const entries = Object.entries(value ?? {});

  const updateKey = (oldKey: string, newKey: string) => {
    if (newKey === oldKey || !newKey.trim()) return;
    const next = { ...value };
    next[newKey.trim()] = next[oldKey];
    delete next[oldKey];
    onChange(next);
  };

  const updateValue = (key: string, v: unknown) => {
    onChange({ ...value, [key]: v });
  };

  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  const addField = () => {
    const base = "key";
    let name = base;
    let i = 0;
    while (name in (value ?? {})) name = `${base}${++i}`;
    onChange({ ...value, [name]: "" });
  };

  return (
    <div className="space-y-2 rounded-lg border border-foreground/10 bg-foreground/5 p-3">
      <div className="space-y-2">
        {entries.map(([key]) => (
          <div key={key} className="flex flex-wrap items-start gap-2 gap-y-1">
            <input
              type="text"
              value={key}
              onChange={(e) => updateKey(key, e.target.value)}
              disabled={disabled}
              placeholder="key"
              className="w-28 shrink-0 rounded border border-stone-200 bg-stone-50 px-2 py-1.5 text-xs font-mono text-stone-900 outline-none focus:border-emerald-500/30 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#f5f7fa]"
            />
            <span className="text-muted-foreground/60 pt-1.5">=</span>
            <div className="flex-1 min-w-36">
              <GenericValueEditor
                value={value[key]}
                onChange={(v) => updateValue(key, v)}
                disabled={disabled}
                depth={depth + 1}
              />
            </div>
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(key)}
                className="rounded p-1 text-muted-foreground/60 hover:text-red-400 transition-colors shrink-0"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={addField}
          className="flex items-center gap-1.5 rounded-lg border border-dashed border-stone-200 px-3 py-1.5 text-xs text-stone-500 transition-colors hover:border-emerald-500/30 hover:text-emerald-700 dark:border-[#2c343d] dark:text-[#a8b0ba] dark:hover:text-emerald-300"
        >
          <Plus className="h-3.5 w-3.5" />
          Add field
        </button>
      )}
    </div>
  );
}

/** Array as list: add/remove items, each item edited by type. */
function GenericArrayEditor({
  value,
  onChange,
  disabled,
  depth,
}: {
  value: unknown[];
  onChange: (v: unknown[]) => void;
  disabled?: boolean;
  depth: number;
}) {
  if (depth >= MAX_GENERIC_EDITOR_DEPTH) {
    return <FormViewEditInRawPlaceholder />;
  }
  const list = Array.isArray(value) ? value : [];

  const updateItem = (idx: number, v: unknown) => {
    const next = [...list];
    next[idx] = v;
    onChange(next);
  };

  const removeItem = (idx: number) => {
    onChange(list.filter((_, i) => i !== idx));
  };

  const addItem = (type: "string" | "number" | "boolean" | "object" | "array") => {
    const empty =
      type === "string" ? "" :
      type === "number" ? 0 :
      type === "boolean" ? false :
      type === "object" ? {} : [];
    onChange([...list, empty]);
  };

  return (
    <div className="space-y-2 rounded-lg border border-foreground/10 bg-foreground/5 p-3">
      <div className="space-y-2">
        {list.map((item, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <span className="text-xs text-muted-foreground/60 pt-1.5 shrink-0 w-5">{idx + 1}.</span>
            <div className="flex-1 min-w-0">
              <GenericValueEditor
                value={item}
                onChange={(v) => updateItem(idx, v)}
                disabled={disabled}
                depth={depth + 1}
              />
            </div>
            {!disabled && (
              <button
                type="button"
                onClick={() => removeItem(idx)}
                className="rounded p-1 text-muted-foreground/60 hover:text-red-400 transition-colors shrink-0"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground/80">Add:</span>
          {(["string", "number", "boolean", "object", "array"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => addItem(t)}
              className="rounded border border-stone-200 px-2 py-1 text-xs font-medium text-stone-500 hover:border-emerald-500/30 hover:text-emerald-700 transition-colors dark:border-[#2c343d] dark:text-[#a8b0ba] dark:hover:text-emerald-300"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Section renderer — renders all fields in a config section
   ================================================================ */

/** One key inside a section or nested object, with schema + validation. */
function ConfigField({
  path,
  label,
  help,
  schema,
  hint,
  value,
  exists,
  sensitive,
  disabled,
  onFieldChange,
}: {
  path: string;
  label: string;
  help?: string;
  schema: JsonSchema | undefined;
  hint: UiHint | undefined;
  value: unknown;
  exists: boolean;
  sensitive: boolean;
  disabled: boolean;
  onFieldChange: (path: string, value: unknown) => void;
}) {
  const fieldType = inferFieldType(schema, hint);
  const neverSet = !exists && value === undefined;

  return (
    <FieldShell
      path={path}
      label={label}
      help={help}
      value={value}
      exists={exists}
      sensitive={sensitive}
      disabled={disabled}
    >
      {({ disabled: effectiveDisabled }) =>
        neverSet ? (
          <button
            type="button"
            disabled={effectiveDisabled}
            onClick={() => onFieldChange(path, emptyValueForType(fieldType, schema))}
            className="flex items-center gap-1.5 rounded-lg border border-dashed border-stone-200 px-3 py-1.5 text-xs text-stone-500 transition-colors hover:border-emerald-500/30 hover:text-emerald-700 disabled:opacity-50 dark:border-[#2c343d] dark:text-[#a8b0ba] dark:hover:text-emerald-300"
          >
            <Plus className="h-3 w-3" />
            Not set — configure
          </button>
        ) : (
          renderField(
            fieldType,
            value,
            (v) => onFieldChange(path, v),
            schema,
            hint,
            sensitive,
            effectiveDisabled
          )
        )
      }
    </FieldShell>
  );
}

function SectionFields({
  sectionKey,
  sectionSchema,
  sectionValue,
  hints,
  showSensitive,
  onFieldChange,
  disabled,
  rawConfig,
  onJumpToSection,
}: {
  sectionKey: string;
  sectionSchema: JsonSchema | undefined;
  sectionValue: unknown;
  hints: Record<string, UiHint>;
  showSensitive: boolean;
  onFieldChange: (path: string, value: unknown) => void;
  disabled: boolean;
  rawConfig?: Record<string, unknown> | null;
  onJumpToSection?: (key: string) => void;
}) {
  const props = sectionSchema?.properties || {};
  const val =
    sectionValue && typeof sectionValue === "object" && !Array.isArray(sectionValue)
      ? (sectionValue as Record<string, unknown>)
      : {};

  if (sectionValue != null && (typeof sectionValue !== "object" || Array.isArray(sectionValue))) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground/70">
          This section holds a single value rather than a set of fields.
        </p>
        <GenericValueEditor
          value={sectionValue}
          onChange={(v) => onFieldChange(sectionKey, v)}
          disabled={disabled}
          depth={0}
        />
      </div>
    );
  }

  // In openclaw.json, default model lives under agents.defaults.model, not under top-level "models".
  // If we're in the Models section and that exists, show a cross-link so the UI matches the file.
  const agentsDefaultsModel =
    sectionKey === "models" && rawConfig?.agents && typeof rawConfig.agents === "object"
      ? (rawConfig.agents as Record<string, unknown>)?.defaults &&
        typeof (rawConfig.agents as Record<string, unknown>).defaults === "object"
        ? ((rawConfig.agents as Record<string, unknown>).defaults as Record<string, unknown>)?.model
        : undefined
      : undefined;

  // Every key the schema declares plus every key actually present, so a
  // never-configured field is still offered instead of being invisible.
  const allKeys = Array.from(
    new Set([...Object.keys(props), ...Object.keys(val)])
  );

  // Sort: schema-defined first (by hint order), then extras
  allKeys.sort((a, b) => {
    const aHint = hints[`${sectionKey}.${a}`];
    const bHint = hints[`${sectionKey}.${b}`];
    const aOrder = aHint?.order ?? 999;
    const bOrder = bHint?.order ?? 999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-4">
      {agentsDefaultsModel != null && onJumpToSection && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-500/20 dark:bg-emerald-500/10">
          <p className="text-xs text-foreground/80">
            Default model (primary + fallbacks) is configured under <strong>Agents → defaults → model</strong>.
          </p>
          <button
            type="button"
            onClick={() => onJumpToSection("agents")}
            className="mt-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800 transition-colors dark:text-emerald-300 dark:hover:text-emerald-200"
          >
            Go to Agents →
          </button>
        </div>
      )}
      {allKeys.map((key) => {
        const fullPath = `${sectionKey}.${key}`;
        const fieldSchema = props[key];
        const fieldValue = val[key];
        const hint = hints[fullPath];
        const label = getLabel(hints, fullPath, key);
        const help = getHelp(hints, fullPath);
        const sensitive = isSensitivePath(hints, fullPath) && !showSensitive;
        const fieldType = inferFieldType(fieldSchema, hint);
        const exists = key in val;

        // For nested objects: use dedicated UI for model primary/fallbacks (no raw JSON)
        if (
          fieldType === "object" &&
          fieldValue &&
          typeof fieldValue === "object" &&
          !Array.isArray(fieldValue)
        ) {
          if (isModelPrimaryFallbacksShape(fieldValue)) {
            return (
              <div key={key} className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground/70">
                  {label}
                  {help && <span className="text-muted-foreground/60 font-normal">— {help}</span>}
                </div>
                <ModelPrimaryFallbacksEditor
                  path={fullPath}
                  value={fieldValue}
                  hints={hints}
                  onFieldChange={onFieldChange}
                  disabled={disabled}
                />
              </div>
            );
          }
          return (
            <NestedSection
              key={key}
              path={fullPath}
              label={label}
              help={help}
              schema={fieldSchema}
              value={fieldValue as Record<string, unknown>}
              hints={hints}
              showSensitive={showSensitive}
              onFieldChange={onFieldChange}
              disabled={disabled}
            />
          );
        }

        return (
          <ConfigField
            key={key}
            path={fullPath}
            label={label}
            help={help}
            schema={fieldSchema}
            hint={hint}
            value={fieldValue}
            exists={exists}
            sensitive={sensitive}
            disabled={disabled}
            onFieldChange={onFieldChange}
          />
        );
      })}
      {allKeys.length === 0 && (
        <p className="text-xs text-muted-foreground/70">
          This section is empty. Add fields in the <strong>Raw</strong> tab, or remove it from the
          section header.
        </p>
      )}
    </div>
  );
}

function renderField(
  fieldType: string,
  value: unknown,
  onChange: (v: unknown) => void,
  schema: JsonSchema | undefined,
  hint: UiHint | undefined,
  sensitive: boolean,
  disabled: boolean
) {
  switch (fieldType) {
    case "string":
      return (
        <StringField
          key={sensitive ? "masked" : "plain"}
          value={String(value ?? "")}
          onChange={onChange}
          sensitive={sensitive}
          disabled={disabled}
          placeholder={hint?.placeholder}
        />
      );
    case "number":
      return (
        <NumberField
          value={typeof value === "number" ? value : undefined}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "boolean":
      return (
        <BooleanField
          value={Boolean(value)}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "enum": {
      const options =
        hint?.enum ||
        extractEnumValues(schema);
      return (
        <EnumField
          value={String(value ?? "")}
          options={options}
          onChange={onChange}
          disabled={disabled}
        />
      );
    }
    case "array":
      return (
        <ArrayField
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          itemSchema={schema?.items}
          disabled={disabled}
        />
      );
    default: {
      if (Array.isArray(value)) {
        return (
          <GenericArrayEditor
            value={value}
            onChange={(v) => onChange(Array.isArray(v) ? v : [v])}
            disabled={disabled}
            depth={0}
          />
        );
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return (
          <GenericObjectEditor
            value={(value ?? {}) as Record<string, unknown>}
            onChange={(v) => onChange(v)}
            disabled={disabled}
            depth={0}
          />
        );
      }
      return (
        <GenericValueEditor value={value} onChange={onChange} disabled={disabled} depth={0} />
      );
    }
  }
}

/* ================================================================
   Nested section (collapsible sub-object)
   ================================================================ */

function NestedSection({
  path,
  label,
  help,
  schema,
  value,
  hints,
  showSensitive,
  onFieldChange,
  disabled,
}: {
  path: string;
  label: string;
  help?: string;
  schema: JsonSchema | undefined;
  value: Record<string, unknown>;
  hints: Record<string, UiHint>;
  showSensitive: boolean;
  onFieldChange: (path: string, value: unknown) => void;
  disabled: boolean;
}) {
  const { highlightPath, onDelete } = useFieldEnv();
  const props = schema?.properties || {};
  const allKeys = Array.from(
    new Set([...Object.keys(props), ...Object.keys(value)])
  );
  const [expanded, setExpanded] = useState(allKeys.length <= 4);
  // "Jump to field" must reach a field inside a collapsed group, so a highlight
  // inside this subtree forces it open (derived, not stored — collapsing again
  // is the user's call once the highlight fades).
  const isOpen = expanded || Boolean(highlightPath?.startsWith(`${path}.`));

  allKeys.sort((a, b) => {
    const aHint = hints[`${path}.${a}`];
    const bHint = hints[`${path}.${b}`];
    const aOrder = aHint?.order ?? 999;
    const bOrder = bHint?.order ?? 999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.localeCompare(b);
  });

  // If schema has no known properties, it's a dynamic map — use JSON fallback
  const isDynamicMap =
    Object.keys(props).length === 0 &&
    (schema?.additionalProperties !== undefined ||
      schema?.propertyNames !== undefined);

  return (
    <div className="rounded-lg border border-foreground/5 bg-foreground/5" id={`cfg-field-${path}`}>
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(!isOpen)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          )}
          <span className="text-xs font-medium text-foreground/70">{label}</span>
          <span className="text-xs text-muted-foreground/60">
            {allKeys.length} field{allKeys.length !== 1 ? "s" : ""}
          </span>
        </button>
        {!disabled && (
          <button
            type="button"
            onClick={() => onDelete(path)}
            aria-label={`Remove ${path}`}
            title={`Remove ${label} from the configuration`}
            className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-red-500/10 hover:text-red-500"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      {isOpen && (
        <div className="border-t border-foreground/5 px-3 py-3 space-y-3">
          {help && (
            <p className="text-xs text-muted-foreground/60 leading-relaxed">{help}</p>
          )}
          {isDynamicMap ? (
            <GenericObjectEditor
              value={typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}}
              onChange={(v) => onFieldChange(path, v)}
              disabled={disabled}
              depth={0}
            />
          ) : (
            allKeys.map((key) => {
              const fullPath = `${path}.${key}`;
              const fieldSchema = props[key];
              const fieldValue = value[key];
              const hint = hints[fullPath];
              const fLabel = getLabel(hints, fullPath, key);
              const fHelp = getHelp(hints, fullPath);
              const sensitive = isSensitivePath(hints, fullPath) && !showSensitive;
              const fieldType = inferFieldType(fieldSchema, hint);
              const exists = key in value;

              // Dedicated UI for model primary/fallbacks (no raw JSON)
              if (
                fieldType === "object" &&
                fieldValue &&
                typeof fieldValue === "object" &&
                !Array.isArray(fieldValue) &&
                isModelPrimaryFallbacksShape(fieldValue)
              ) {
                return (
                  <div key={key} className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-foreground/70">
                      {fLabel}
                      {fHelp && <span className="text-muted-foreground/60 font-normal">— {fHelp}</span>}
                    </div>
                    <ModelPrimaryFallbacksEditor
                      path={fullPath}
                      value={fieldValue}
                      hints={hints}
                      onFieldChange={onFieldChange}
                      disabled={disabled}
                    />
                  </div>
                );
              }
              // Recurse for other nested objects
              if (
                fieldType === "object" &&
                fieldValue &&
                typeof fieldValue === "object" &&
                !Array.isArray(fieldValue)
              ) {
                return (
                  <NestedSection
                    key={key}
                    path={fullPath}
                    label={fLabel}
                    help={fHelp}
                    schema={fieldSchema}
                    value={fieldValue as Record<string, unknown>}
                    hints={hints}
                    showSensitive={showSensitive}
                    onFieldChange={onFieldChange}
                    disabled={disabled}
                  />
                );
              }

              return (
                <ConfigField
                  key={key}
                  path={fullPath}
                  label={fLabel}
                  help={fHelp}
                  schema={fieldSchema}
                  hint={hint}
                  value={fieldValue}
                  exists={exists}
                  sensitive={sensitive}
                  disabled={disabled}
                  onFieldChange={onFieldChange}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Normalize JSON string for dirty comparison (parse + re-stringify). */
export function normalizedJsonString(str: string): string | null {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return null;
  }
}

/** Redact sensitive values for display when raw masking is on. */
export function redactConfigForDisplay(
  obj: unknown,
  hints: Record<string, UiHint>,
  pathPrefix = ""
): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item, i) => redactConfigForDisplay(item, hints, `${pathPrefix}[${i}]`));
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (typeof value === "string" && isSensitivePath(hints, fullPath)) {
        result[key] = value.length > 8 ? "••••••••" : "••••";
      } else {
        result[key] = redactConfigForDisplay(value, hints, fullPath);
      }
    }
    return result;
  }
  return obj;
}

/* ================================================================
   Main ConfigEditor
   ================================================================ */

type PendingSave = {
  baseDoc: JsonObject;
  nextDoc: JsonObject;
  hash: string;
  replacePaths: string[];
  fromRaw: boolean;
  rawText: string;
};

export function ConfigEditor() {
  /** The document as loaded — never mutated. Every diff is measured from it. */
  const [baseSnapshot, setBaseSnapshot] = useState<JsonObject | null>(null);
  /** The document as edited. */
  const [draft, setDraft] = useState<JsonObject | null>(null);
  const [baseHash, setBaseHash] = useState("");
  const [schema, setSchema] = useState<Record<string, JsonSchema>>({});
  const [hints, setHints] = useState<Record<string, UiHint>>({});
  const [envSubstituted, setEnvSubstituted] = useState<string[]>([]);
  const [configSource, setConfigSource] = useState<"parsed" | "resolved" | "disk">("parsed");
  const [fetchWarning, setFetchWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showSensitive, setShowSensitive] = useState(false);
  const [search, setSearch] = useState("");
  const [showRawJson, setShowRawJson] = useState(false);
  /** Raw JSON editor content (when in raw view). Synced when entering raw view. */
  const [rawEditorValue, setRawEditorValue] = useState<string>("");
  /** Raw masking is its own concern — the editor is editable by default. */
  const [rawMaskSecrets, setRawMaskSecrets] = useState(false);

  // Write-flow state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [errorDetail, setErrorDetail] = useState<ConfigErrorDetail | null>(null);
  const [conflict, setConflict] = useState<{
    message: string;
    currentHash: string;
    remoteConfig: JsonObject;
  } | null>(null);
  const [replaceConfirm, setReplaceConfirm] = useState<{
    paths: string[];
    message: string;
  } | null>(null);
  const [saveSummary, setSaveSummary] = useState<SaveSuccess | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [validity, setValidity] = useState<Record<string, string>>({});
  const [blockingErrors, setBlockingErrors] = useState<
    Array<{ path: string; message: string }>
  >([]);
  const [highlightPath, setHighlightPath] = useState<string | null>(null);

  // Sidebar "Jump to" group expand/collapse (folder-explorer style). Set = collapsed group names.
  const [sidebarGroupsCollapsed, setSidebarGroupsCollapsed] = useState<Set<string>>(new Set());

  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const hasInitialExpand = useRef(false);
  const pendingSaveRef = useRef<PendingSave | null>(null);

  const lookupApi = useConfigLookupSource();
  const {
    ensure: ensureLookups,
    request: requestLookups,
    reset: resetLookups,
  } = lookupApi;

  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  /* ── Fetch ─────────────────────────── */

  const fetchConfig = useCallback(
    async (opts?: { silent?: boolean }): Promise<JsonObject | null> => {
      if (!opts?.silent) setLoading(true);
      setFetchWarning(null);
      try {
        // `config` is the gateway's `parsed` document: `${VAR}` stays literal so
        // a round-trip cannot bake env indirection into its expansion.
        const payload = await fetchConfigPayload();
        setBaseSnapshot(payload.config);
        setDraft(payload.config);
        setBaseHash(payload.baseHash);
        setSchema(payload.schema as Record<string, JsonSchema>);
        setHints(payload.uiHints as Record<string, UiHint>);
        setEnvSubstituted(payload.envSubstituted);
        setConfigSource(payload.configSource);
        if (payload.warning) setFetchWarning(payload.warning);
        setLoadError(null);
        setLoading(false);
        setValidity({});
        setBlockingErrors([]);
        return payload.config;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        console.warn("Config fetch error:", err);
        setLoading(false);
        return null;
      }
    },
    []
  );

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  /* ── Diff ──────────────────────────── */

  const diff = useMemo(
    () => buildConfigDiff(baseSnapshot ?? {}, draft ?? {}),
    [baseSnapshot, draft]
  );

  const dirtySections = useMemo(
    () => new Set(diff.changedPaths.map((p) => p.split(".")[0])),
    [diff.changedPaths]
  );

  const rawParsed = useMemo<JsonObject | null>(() => {
    if (!showRawJson) return null;
    try {
      const parsed = JSON.parse(rawEditorValue) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonObject)
        : null;
    } catch {
      return null;
    }
  }, [showRawJson, rawEditorValue]);

  const rawViewDirty =
    showRawJson &&
    draft !== null &&
    (() => {
      const norm = normalizedJsonString(rawEditorValue);
      return norm !== null && norm !== JSON.stringify(draft, null, 2);
    })();

  const hasDirty = diff.changed || Boolean(rawViewDirty);

  /* ── Section ordering ────────────── */
  // Sections come from the SCHEMA unioned with the document, so a section that
  // has never been written to disk (cron, memory, …) can still be created here
  // instead of forcing the user into the Raw tab.

  const sections = useMemo(() => {
    const keys = new Set<string>();
    for (const key of Object.keys(schema)) {
      if (!key.startsWith("$")) keys.add(key);
    }
    for (const key of Object.keys(draft ?? {})) keys.add(key);
    return Array.from(keys).sort((a, b) => {
      const aOrder = hints[a]?.order ?? 999;
      const bOrder = hints[b]?.order ?? 999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.localeCompare(b);
    });
  }, [schema, draft, hints]);

  const fieldIndex = useMemo<FieldIndexEntry[]>(
    () =>
      buildFieldIndex(
        draft ?? {},
        schema as Record<string, { properties?: Record<string, unknown> }>,
        hints
      ),
    [draft, schema, hints]
  );

  const fieldMatches = useMemo(
    () => searchFields(fieldIndex, search),
    [fieldIndex, search]
  );

  const filteredSections = useMemo(() => {
    if (!search) return sections;
    const q = search.toLowerCase();
    const matchedSections = new Set(fieldMatches.map((m) => m.section));
    return sections.filter((s) => {
      const label = hints[s]?.label || s;
      if (label.toLowerCase().includes(q) || s.toLowerCase().includes(q)) return true;
      return matchedSections.has(s);
    });
  }, [search, sections, hints, fieldMatches]);

  /** Sections grouped by hint.group for easier scanning */
  const groupedSections = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of filteredSections) {
      const group = (hints[key]?.group as string) || "General";
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(key);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      const ai = GROUP_ORDER.indexOf(a);
      const bi = GROUP_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [filteredSections, hints]);

  // Expand first section on first load so the page isn't a wall of collapsed cards
  useEffect(() => {
    if (filteredSections.length > 0 && !hasInitialExpand.current) {
      hasInitialExpand.current = true;
      setExpanded((prev) => new Set([...prev, filteredSections[0]]));
    }
  }, [filteredSections]);

  /* ── Schema lookups for everything on screen ─────────────── */

  useEffect(() => {
    if (!draft) return;
    // Prefetch the visible sections' immediate children — the batching hook
    // de-duplicates, caps each request at 25 paths and caches the answers.
    const wanted: string[] = [];
    for (const sectionKey of expanded) {
      const value = draft[sectionKey];
      const props = schema[sectionKey]?.properties ?? {};
      const keys = new Set([
        ...Object.keys(props),
        ...(value && typeof value === "object" && !Array.isArray(value)
          ? Object.keys(value as JsonObject)
          : []),
      ]);
      for (const key of keys) wanted.push(`${sectionKey}.${key}`);
    }
    if (wanted.length > 0) requestLookups(wanted.slice(0, 200));
  }, [draft, schema, expanded, requestLookups]);

  const jumpToSection = useCallback((sectionKey: string) => {
    setExpanded((prev) => new Set([...prev, sectionKey]));
    requestAnimationFrame(() => {
      sectionRefs.current[sectionKey]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const jumpToField = useCallback((path: string) => {
    const sectionKey = path.split(".")[0];
    setExpanded((prev) => new Set([...prev, sectionKey]));
    setHighlightPath(path);
    // Two frames: one for the section to expand, one for nested groups to open.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`cfg-field-${path}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        else sectionRefs.current[sectionKey]?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }, []);

  useEffect(() => {
    if (!highlightPath) return;
    const t = setTimeout(() => setHighlightPath(null), 3500);
    return () => clearTimeout(t);
  }, [highlightPath]);

  /* ── Field editing ─────────────────── */

  const handleFieldChange = useCallback((path: string, value: unknown) => {
    setDraft((prev) => (prev ? setAtPath(prev, path, value) : prev));
  }, []);

  /**
   * Real deletion: the key is removed from the draft, so `buildConfigDiff`
   * emits an explicit `null` and OpenClaw actually drops it. Before this, the
   * form dropped the key locally and the whole-document merge patch simply
   * left it in place — a silent no-op reported as "saved successfully".
   */
  const handleFieldDelete = useCallback((path: string) => {
    setDraft((prev) => (prev ? deleteAtPath(prev, path) : prev));
  }, []);

  const reportValidity = useCallback((path: string, message: string | null) => {
    setValidity((prev) => {
      if (message === null) {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      }
      if (prev[path] === message) return prev;
      return { ...prev, [path]: message };
    });
  }, []);

  const fieldEnv = useMemo<FieldEnv>(
    () => ({
      hints,
      showSensitive,
      envSubstituted,
      reportValidity,
      onDelete: handleFieldDelete,
      highlightPath,
    }),
    [hints, showSensitive, envSubstituted, reportValidity, handleFieldDelete, highlightPath]
  );

  /* ── Preview data ──────────────────── */

  const previewDoc: JsonObject | null = showRawJson ? rawParsed : draft;

  const previewDiff = useMemo(() => {
    if (!showRawJson) return diff;
    return buildConfigDiff(baseSnapshot ?? {}, rawParsed ?? baseSnapshot ?? {});
  }, [showRawJson, diff, baseSnapshot, rawParsed]);

  const changeEntries = useMemo<ChangeEntry[]>(
    () =>
      describeChanges(baseSnapshot ?? {}, previewDoc ?? {}, previewDiff, {
        hints,
        envSubstituted,
        lookup: (path) => lookupApi.get(path),
      }),
    [baseSnapshot, previewDoc, previewDiff, hints, envSubstituted, lookupApi]
  );

  const restartPlan = useMemo(() => planRestart(changeEntries), [changeEntries]);
  const authTokenMint = useMemo(
    () => detectAuthTokenMint(baseSnapshot ?? {}, previewDoc ?? {}),
    [baseSnapshot, previewDoc]
  );

  /* ── Save ───────────────────────────── */

  const runDoctorCheck = useCallback(async () => {
    setDoctorRunning(true);
    try {
      setDoctorReport(await runDoctor(true));
    } catch (err) {
      console.warn("Doctor check failed:", err);
      setDoctorReport(null);
    } finally {
      setDoctorRunning(false);
    }
  }, []);

  const performSave = useCallback(
    async (params: PendingSave) => {
      pendingSaveRef.current = params;
      setSaving(true);
      setErrorDetail(null);
      setReplaceConfirm(null);

      const request = params.fromRaw
        ? // A raw save is a full document: `config.apply` is a validated full
          // replace, so keys the user deleted really disappear and arrays can
          // shrink without a replacePaths confirmation.
          { raw: params.rawText, baseHash: params.hash, mode: "apply" as const }
        : buildSaveBody(params.baseDoc, params.nextDoc, params.hash, params.replacePaths).body;

      const result = await saveConfig(request);

      if (result.status === "conflict") {
        setSaving(false);
        setPreviewOpen(false);
        setConflict({
          message: result.message,
          currentHash: result.currentHash,
          remoteConfig: result.remoteConfig,
        });
        return;
      }

      if (result.status === "needs-replace-confirm") {
        setSaving(false);
        setPreviewOpen(false);
        setReplaceConfirm({ paths: result.paths, message: result.message });
        return;
      }

      if (result.status === "rate-limited") {
        setSaving(false);
        setPreviewOpen(false);
        setErrorDetail({
          title: "Too many configuration writes",
          message: result.message,
          details: result.details,
          retryAfterMs: result.retryAfterMs,
          at: Date.now(),
        });
        return;
      }

      if (result.status === "error") {
        setSaving(false);
        setPreviewOpen(false);
        setErrorDetail({
          title: "The configuration was not saved",
          message: result.message,
          details: result.details,
          doctorOutput: result.doctorOutput,
          fallback: result.fallback,
          at: Date.now(),
        });
        return;
      }

      // Success.
      setSaving(false);
      setPreviewOpen(false);
      setSaveSummary(result);
      setSavedAt(Date.now());
      setToast({ ok: true, msg: "Configuration saved" });
      // Restart only when the server says a touched path needs one — the old
      // editor restarted on every save, against a 30s restart cooldown.
      if (result.restartRequired) {
        requestRestart(
          `Configuration saved. ${
            result.restartPaths.length > 0
              ? `${result.restartPaths.join(", ")} needs`
              : "A changed setting needs"
          } a gateway restart.`
        );
      }
      resetLookups();
      // Re-read rather than trusting `result.hash` alone: the GET is also the
      // receipt that the write landed, and its hash is the newest one even if
      // another operator wrote in between.
      const fresh = await fetchConfig({ silent: true });
      if (params.fromRaw && fresh) {
        setRawEditorValue(JSON.stringify(fresh, null, 2));
      }
      void runDoctorCheck();
    },
    [fetchConfig, resetLookups, runDoctorCheck]
  );

  /**
   * Gate: validate every path this write touches — including fields whose
   * section is collapsed — then show the diff preview. This is what makes the
   * header's "checked before saving" claim true.
   */
  const requestSave = useCallback(async () => {
    setErrorDetail(null);
    setBlockingErrors([]);

    if (showRawJson && rawParsed === null) {
      setErrorDetail({
        title: "That is not valid JSON",
        message:
          "The raw editor must contain a JSON object. Fix the syntax highlighted in the editor and try again.",
        at: Date.now(),
      });
      return;
    }

    const nextDoc = (showRawJson ? rawParsed : draft) ?? {};
    const activeDiff = showRawJson
      ? buildConfigDiff(baseSnapshot ?? {}, nextDoc)
      : diff;

    if (!activeDiff.changed) {
      setToast({ ok: true, msg: "Nothing to save — no changes yet" });
      return;
    }

    setSaving(true);
    try {
      await ensureLookups(activeDiff.changedPaths.slice(0, 200));
    } finally {
      setSaving(false);
    }

    const problems: Array<{ path: string; message: string }> = [];
    for (const path of activeDiff.changedPaths) {
      const info = lookupApi.get(path);
      if (!info) continue;
      const check = validateConfigValue(info, getAtPath(nextDoc, path));
      if (!check.ok) problems.push({ path, message: check.message });
    }
    if (problems.length > 0) {
      setBlockingErrors(problems);
      return;
    }

    pendingSaveRef.current = {
      baseDoc: baseSnapshot ?? {},
      nextDoc,
      hash: baseHash,
      replacePaths: activeDiff.replacePaths,
      fromRaw: showRawJson,
      rawText: showRawJson ? rawEditorValue : JSON.stringify(nextDoc, null, 2),
    };
    setPreviewOpen(true);
  }, [
    showRawJson,
    rawParsed,
    draft,
    diff,
    baseSnapshot,
    baseHash,
    rawEditorValue,
    ensureLookups,
    lookupApi,
  ]);

  const confirmSave = useCallback(() => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    void performSave(pending);
  }, [performSave]);

  const confirmReplacePaths = useCallback(() => {
    const pending = pendingSaveRef.current;
    if (!pending || !replaceConfirm) return;
    void performSave({
      ...pending,
      replacePaths: Array.from(new Set([...pending.replacePaths, ...replaceConfirm.paths])),
    });
  }, [performSave, replaceConfirm]);

  /* ── Conflict resolution ───────────── */

  const conflictAnalysis = useMemo(
    () =>
      analyzeConflict(
        baseSnapshot ?? {},
        (showRawJson ? rawParsed : draft) ?? {},
        conflict?.remoteConfig ?? {}
      ),
    [baseSnapshot, showRawJson, rawParsed, draft, conflict]
  );

  const resolveWithTheirs = useCallback(() => {
    if (!conflict) return;
    setBaseSnapshot(conflict.remoteConfig);
    setDraft(conflict.remoteConfig);
    setBaseHash(conflict.currentHash);
    if (showRawJson) setRawEditorValue(JSON.stringify(conflict.remoteConfig, null, 2));
    setConflict(null);
    setValidity({});
    setBlockingErrors([]);
    setToast({ ok: true, msg: "Reloaded the current configuration — your edits were discarded" });
  }, [conflict, showRawJson]);

  const resolveWithRebase = useCallback(() => {
    if (!conflict) return;
    const mine = (showRawJson ? rawParsed : draft) ?? {};
    const myDiff = buildConfigDiff(baseSnapshot ?? {}, mine);
    // Replay my minimal patch on top of their document, then save against
    // THEIR hash — the write is still guarded, it is just guarded by the base
    // I actually rebased onto.
    const rebased = applyMergePatch(conflict.remoteConfig, myDiff.patch) as JsonObject;
    const rebasedDiff = buildConfigDiff(conflict.remoteConfig, rebased);
    setBaseSnapshot(conflict.remoteConfig);
    setDraft(rebased);
    setBaseHash(conflict.currentHash);
    if (showRawJson) setRawEditorValue(JSON.stringify(rebased, null, 2));
    setConflict(null);
    void performSave({
      baseDoc: conflict.remoteConfig,
      nextDoc: rebased,
      hash: conflict.currentHash,
      replacePaths: rebasedDiff.replacePaths,
      fromRaw: showRawJson,
      rawText: JSON.stringify(rebased, null, 2),
    });
  }, [conflict, showRawJson, rawParsed, draft, baseSnapshot, performSave]);

  /* ── Discard ────────────────────── */

  const discardChanges = useCallback(async () => {
    const fresh = await fetchConfig({ silent: true });
    if (showRawJson && fresh) setRawEditorValue(JSON.stringify(fresh, null, 2));
    setBlockingErrors([]);
    setErrorDetail(null);
    setReplaceConfirm(null);
  }, [fetchConfig, showRawJson]);

  const toggleRawView = useCallback(() => {
    const next = !showRawJson;
    if (next && draft) {
      setRawEditorValue(JSON.stringify(draft, null, 2));
    }
    if (!next && rawEditorValue) {
      try {
        const parsed = JSON.parse(rawEditorValue) as JsonObject;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setDraft(parsed);
        }
      } catch {
        // keep the current draft when the raw JSON is invalid
      }
    }
    setShowRawJson(next);
  }, [showRawJson, draft, rawEditorValue]);

  const toggleSection = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const createSection = useCallback((sectionKey: string) => {
    setDraft((prev) => (prev ? { ...prev, [sectionKey]: {} } : prev));
    setExpanded((prev) => new Set([...prev, sectionKey]));
  }, []);

  const removeSection = useCallback((sectionKey: string) => {
    setDraft((prev) => (prev ? deleteAtPath(prev, sectionKey) : prev));
  }, []);

  /* ── Unsaved-changes guard ─────────── */

  useEffect(() => {
    if (!hasDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // Next's client router navigates via <Link> anchors; intercept in the
    // capture phase so a stray click cannot silently discard the draft.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute("href") || "";
      if (!href.startsWith("/") || anchor.target === "_blank") return;
      if (href === window.location.pathname + window.location.search) return;
      const ok = window.confirm(
        "You have unsaved configuration changes. Leave this page and discard them?"
      );
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [hasDirty]);

  /* ── Loading state ─────────────── */

  if (loading) {
    return (
      <SectionLayout>
        <ContentLoadingState size="lg" />
      </SectionLayout>
    );
  }

  if (!draft || !baseSnapshot) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
        <div className="flex items-center">
          <AlertCircle className="mr-2 h-4 w-4" />
          Failed to load configuration
        </div>
        {loadError && (
          <p className="max-w-xl text-center text-xs text-muted-foreground/80">
            {loadError}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            void fetchConfig();
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-muted/50 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted/80"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    );
  }

  const liveValidationAvailable = lookupApi.reason === null;
  const inlineErrorCount = Object.keys(validity).length;

  /* ── Render ─────────────────────── */

  return (
    <ConfigLookupContext.Provider value={lookupApi}>
    <FieldEnvContext.Provider value={fieldEnv}>
    <SectionLayout>
      <SectionHeader
        title={
          <span className="flex items-center gap-2 text-xs">
            <Settings2 className="h-5 w-5 text-stone-700 dark:text-[#d6dce3]" />
            Configuration
          </span>
        }
        description={
          liveValidationAvailable
            ? "Edit your OpenClaw settings safely • Every change is checked against the gateway's schema and previewed before it is written"
            : "Edit your OpenClaw settings • Field rules are unavailable right now, so changes are previewed but not fully checked"
        }
        descriptionClassName="text-sm text-muted-foreground"
        actions={
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 dark:border-[#2c343d] dark:bg-[#171a1d]">
              <Search className="h-3.5 w-3.5 text-muted-foreground/60" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search settings..."
                aria-label="Search settings"
                className="w-36 bg-transparent text-xs text-foreground/70 outline-none placeholder:text-muted-foreground/70"
              />
              {search && (
                <button onClick={() => setSearch("")} className="text-muted-foreground/60 hover:text-muted-foreground">
                  <X className="h-3 w-3" />
                </button>
              )}
              {search && fieldMatches.length > 0 && (
                <div className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-xl dark:border-[#2c343d] dark:bg-[#171a1d]">
                  <p className="border-b border-foreground/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {fieldMatches.length} matching field{fieldMatches.length === 1 ? "" : "s"}
                  </p>
                  <ul className="max-h-72 overflow-y-auto">
                    {fieldMatches.map((match) => (
                      <li key={match.path}>
                        <button
                          type="button"
                          data-testid="field-search-result"
                          onClick={() => {
                            jumpToField(match.path);
                            setSearch("");
                          }}
                          className="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-foreground/5"
                        >
                          <span className="text-xs font-medium text-foreground/90">
                            {match.label}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {match.path}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowSensitive(!showSensitive)}
              className={cn(
                "flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
                showSensitive
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                  : "border-foreground/10 text-muted-foreground hover:bg-muted/80"
              )}
            >
              {showSensitive ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              Secrets
            </button>

            <button
              type="button"
              onClick={toggleRawView}
              className={cn(
                "flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
                showRawJson
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-stone-200 bg-white text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#a8b0ba] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
              )}
            >
              <Code className="h-3 w-3" />
              Raw
            </button>

            <button
              type="button"
              onClick={() => {
                void fetchConfig();
              }}
              aria-label="Reload configuration"
              className="rounded-lg border border-stone-200 bg-white p-1.5 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#a8b0ba] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      />

      {fetchWarning && (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 md:px-6">
          <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            {fetchWarning}
          </p>
        </div>
      )}

      {configSource !== "parsed" && (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 md:px-6">
          <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            {configSource === "disk"
              ? "Showing the configuration file from disk because the gateway could not be reached. Saving is not guarded against concurrent edits."
              : "This gateway did not return the authored document, so environment references may already be expanded. Editing a value that came from ${VAR} will replace the reference."}
          </p>
        </div>
      )}

      {/* Unsaved changes bar */}
      {hasDirty && (
        <div className="shrink-0 flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 md:px-6 dark:border-amber-500/20 dark:bg-amber-500/10">
          <Info className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <p className="flex-1 min-w-40 text-xs text-amber-800 dark:text-amber-200">
            {previewDiff.changedPaths.length > 0 ? (
              <>
                <strong>
                  {previewDiff.changedPaths.length} unsaved change
                  {previewDiff.changedPaths.length === 1 ? "" : "s"}
                </strong>
                {previewDiff.deletedPaths.length > 0 && (
                  <> · {previewDiff.deletedPaths.length} removal{previewDiff.deletedPaths.length === 1 ? "" : "s"}</>
                )}
                {dirtySections.size > 0 && <> in {Array.from(dirtySections).join(", ")}</>}
              </>
            ) : (
              <>Unsaved changes in the raw editor</>
            )}
          </p>
          {inlineErrorCount > 0 && (
            <button
              type="button"
              onClick={() => jumpToField(Object.keys(validity)[0])}
              data-testid="config-jump-to-error"
              className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-500/20 dark:text-red-300"
            >
              {inlineErrorCount} field{inlineErrorCount === 1 ? "" : "s"} need fixing — jump there
            </button>
          )}
          <button
            type="button"
            onClick={discardChanges}
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground/70"
          >
            <RotateCcw className="h-3 w-3" />
            Discard
          </button>
          <button
            type="button"
            onClick={() => void requestSave()}
            disabled={saving || inlineErrorCount > 0}
            data-testid="config-review-save"
            title={
              inlineErrorCount > 0
                ? "Fix the highlighted fields before saving"
                : "Review the exact changes before they are written"
            }
            className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-4 py-1.5 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? (
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
              </span>
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {saving ? "Working…" : "Review & save"}
          </button>
        </div>
      )}

      {/* Content */}
      <SectionBody width="wide" padding="compact" innerClassName="space-y-2">
        {/* Blocking validation summary */}
        {blockingErrors.length > 0 && (
          <div
            data-testid="config-validation-summary"
            className="rounded-xl border border-red-500/30 bg-red-50 px-4 py-3 dark:bg-red-950/30"
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold text-red-900 dark:text-red-100">
              <AlertCircle className="h-4 w-4" />
              {blockingErrors.length} change{blockingErrors.length === 1 ? "" : "s"} cannot be saved
            </p>
            <ul className="mt-2 space-y-1.5">
              {blockingErrors.map((problem) => (
                <li key={problem.path} className="text-xs">
                  <button
                    type="button"
                    onClick={() => jumpToField(problem.path)}
                    className="font-mono font-medium text-red-800 underline underline-offset-2 hover:no-underline dark:text-red-200"
                  >
                    {problem.path}
                  </button>
                  <span className="ml-2 text-red-900/90 dark:text-red-100/90">
                    {problem.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Persistent error panel — failures never auto-dismiss */}
        {errorDetail && (
          <ConfigErrorPanel
            error={errorDetail}
            onDismiss={() => setErrorDetail(null)}
            onRetry={
              pendingSaveRef.current
                ? () => {
                    const pending = pendingSaveRef.current;
                    if (pending) void performSave(pending);
                  }
                : undefined
            }
          />
        )}

        {/* replacePathsRequired is a confirmation prompt, not a failure */}
        {replaceConfirm && (
          <div
            data-testid="config-replace-confirm"
            className="rounded-xl border border-amber-500/30 bg-amber-50 px-4 py-3 dark:bg-amber-950/20"
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-100">
              <ListMinus className="h-4 w-4" />
              Confirm removing list entries
            </p>
            <p className="mt-1 text-xs text-amber-900/90 dark:text-amber-100/90">
              This change removes entries from {replaceConfirm.paths.length} list
              {replaceConfirm.paths.length === 1 ? "" : "s"}. OpenClaw needs an explicit
              confirmation before it will shrink a list.
            </p>
            <p className="mt-1 font-mono text-xs text-amber-900/90 dark:text-amber-100/90">
              {replaceConfirm.paths.join(", ")}
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setReplaceConfirm(null)}
                className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReplacePaths}
                disabled={saving}
                data-testid="config-replace-confirm-accept"
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                Yes, remove them
              </button>
            </div>
          </div>
        )}

        {/* Save receipt */}
        {saveSummary && (
          <div
            data-testid="config-save-receipt"
            className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3"
          >
            <div className="flex items-start gap-2.5">
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground/90">Configuration saved</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {saveSummary.deletedPaths.length > 0 && (
                    <li>
                      Removed:{" "}
                      <code className="font-mono text-foreground/80">
                        {saveSummary.deletedPaths.join(", ")}
                      </code>
                    </li>
                  )}
                  <li>
                    {saveSummary.restartRequired
                      ? `Gateway restart requested${
                          saveSummary.restartPaths.length > 0
                            ? ` (${saveSummary.restartPaths.join(", ")})`
                            : ""
                        }.`
                      : "Applied live — no gateway restart was needed."}
                  </li>
                  {saveSummary.repairedConfig && (
                    <li>An invalid configuration was repaired before the write.</li>
                  )}
                  {saveSummary.fallbackUsed && (
                    <li>{saveSummary.fallbackMessage ?? "Saved in compatibility mode."}</li>
                  )}
                  {saveSummary.warnings.map((w) => (
                    <li key={w} className="text-amber-700 dark:text-amber-300">
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                onClick={() => setSaveSummary(null)}
                aria-label="Dismiss save summary"
                className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Doctor: the standing safety net after every save */}
        {(doctorReport || doctorRunning) && (
          <ConfigDoctorPanel
            report={doctorReport}
            running={doctorRunning}
            savedAt={savedAt}
            onRecheck={() => void runDoctorCheck()}
            onDismiss={() => setDoctorReport(null)}
          />
        )}

        {showRawJson ? (
          /* Raw JSON view — editable by default; masking is a separate concern */
          (() => {
            const redactedRaw = JSON.stringify(
              redactConfigForDisplay(draft, hints),
              null,
              2
            );
            const rawDisplayValue = rawMaskSecrets ? redactedRaw : rawEditorValue;
            return (
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground/70">
                    Raw Configuration
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground/60">
                      {rawMaskSecrets
                        ? "Masked view is read-only — masked values would overwrite the real secrets."
                        : "Edit the JSON directly, then use Review & save. Saved as a full replacement, so removed keys are really removed."}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRawMaskSecrets((v) => !v)}
                      className={cn(
                        "flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
                        rawMaskSecrets
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          : "border-foreground/10 text-muted-foreground hover:bg-muted/80"
                      )}
                    >
                      {rawMaskSecrets ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      {rawMaskSecrets ? "Secrets masked" : "Secrets visible"}
                    </button>
                  </div>
                </div>
                {showRawJson && rawViewDirty && rawParsed === null && (
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                    <AlertCircle className="h-3 w-3" />
                    This is not valid JSON yet — saving is blocked until it parses.
                  </p>
                )}
                <div className="rounded-lg overflow-hidden border border-foreground/10 bg-zinc-800 dark:bg-zinc-800 min-h-96">
                  <MonacoEditor
                    height="70vh"
                    language="json"
                    value={rawDisplayValue}
                    onChange={rawMaskSecrets ? undefined : (v) => setRawEditorValue(v ?? "")}
                    theme={monacoTheme}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: "on",
                      wordWrap: "on",
                      formatOnPaste: !rawMaskSecrets,
                      formatOnType: !rawMaskSecrets,
                      scrollBeyondLastLine: false,
                      padding: { top: 12, bottom: 12 },
                      bracketPairColorization: { enabled: true },
                      folding: true,
                      semanticHighlighting: { enabled: true },
                      readOnly: rawMaskSecrets,
                    } as unknown as NonNullable<React.ComponentProps<typeof MonacoEditor>["options"]>}
                  />
                </div>
              </div>
            );
          })()
        ) : (
          /* Form view: sidebar nav + grouped sections */
          <div className="flex gap-6">
            {/* Sticky sidebar: Jump to section (large screens) */}
            <nav
              aria-label="Config sections"
              className="hidden lg:block shrink-0 w-48 sticky top-4 self-start rounded-xl border border-foreground/10 bg-foreground/5 p-3 max-h-screen overflow-y-auto"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
                Jump to
              </p>
              {groupedSections.map(([groupName, sectionKeys]) => {
                const isCollapsed = sidebarGroupsCollapsed.has(groupName);
                const toggleGroup = () => {
                  setSidebarGroupsCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(groupName)) next.delete(groupName);
                    else next.add(groupName);
                    return next;
                  });
                };
                return (
                  <div key={groupName} className="mb-2">
                    <button
                      type="button"
                      onClick={toggleGroup}
                      className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground/70 hover:bg-foreground/10 hover:text-muted-foreground transition-colors"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      )}
                      <span>{groupName}</span>
                    </button>
                    {!isCollapsed && (
                      <ul className="mt-0.5 space-y-0.5 border-l border-foreground/10 ml-1.5 pl-2">
                        {sectionKeys.map((sectionKey) => {
                          const label = hints[sectionKey]?.label || sectionKey;
                          const icon = SECTION_ICONS[sectionKey] || "📦";
                          const isDirty = dirtySections.has(sectionKey);
                          const configured = sectionKey in draft;
                          return (
                            <li key={sectionKey}>
                              <button
                                type="button"
                                onClick={() => jumpToSection(sectionKey)}
                                className={cn(
                                  "w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                                  isDirty
                                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                    : configured
                                      ? "text-foreground/80 hover:bg-foreground/10 hover:text-foreground"
                                      : "text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground/80"
                                )}
                              >
                                <span className="shrink-0">{icon}</span>
                                <span className="truncate">{label}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </nav>

            {/* Main: grouped section cards */}
            <div className="flex-1 min-w-0 space-y-6">
              {/* Small-screen section nav — the sidebar is hidden below lg */}
              <div className="lg:hidden">
                <label
                  htmlFor="config-section-jump"
                  className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Jump to section
                </label>
                <select
                  id="config-section-jump"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) jumpToSection(e.target.value);
                  }}
                  className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-foreground/90 outline-none dark:border-[#2c343d] dark:bg-[#171a1d]"
                >
                  <option value="">Select a section…</option>
                  {groupedSections.map(([groupName, sectionKeys]) => (
                    <optgroup key={groupName} label={groupName}>
                      {sectionKeys.map((sectionKey) => (
                        <option key={sectionKey} value={sectionKey}>
                          {(hints[sectionKey]?.label || sectionKey) +
                            (dirtySections.has(sectionKey) ? " • modified" : "") +
                            (sectionKey in draft ? "" : " — not configured")}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {groupedSections.map(([groupName, sectionKeys]) => (
                <div key={groupName}>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-0.5">
                    {groupName}
                  </h2>
                  <div className="space-y-2">
                    {sectionKeys.map((sectionKey) => {
                      const isExpanded = expanded.has(sectionKey);
                      const isManaged = MANAGED_SECTIONS.has(sectionKey);
                      const isSensitive = SENSITIVE_SECTIONS.has(sectionKey);
                      const isDirty = dirtySections.has(sectionKey);
                      const sectionHint = hints[sectionKey];
                      const label = sectionHint?.label || sectionKey;
                      const icon = SECTION_ICONS[sectionKey] || "📦";
                      const sectionSchema = schema[sectionKey];
                      const configured = sectionKey in draft;
                      const sectionValue = draft[sectionKey];

                      let fieldCount = 0;
                      if (sectionValue && typeof sectionValue === "object") {
                        fieldCount = Object.keys(sectionValue).length;
                      }

                      return (
                        <div
                          key={sectionKey}
                          ref={(el) => {
                            sectionRefs.current[sectionKey] = el;
                          }}
                          data-config-section={sectionKey}
                          className={cn(
                            "rounded-xl border transition-colors scroll-mt-4",
                            isDirty
                              ? "border-emerald-500/30 bg-emerald-500/10"
                              : configured
                                ? "border-stone-200 bg-white dark:border-[#2c343d] dark:bg-[#171a1d]"
                                : "border-dashed border-stone-200 bg-white/60 dark:border-[#2c343d] dark:bg-[#171a1d]/60"
                          )}
                        >
                          <div
                            className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                            onClick={() => toggleSection(sectionKey)}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
                            )}
                            <span className="text-xs">{icon}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-foreground/90">
                                  {label}
                                </span>
                                {isDirty && (
                                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                                    Modified
                                  </span>
                                )}
                                {!configured && (
                                  <span className="rounded-full border border-foreground/10 bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
                                    Not configured
                                  </span>
                                )}
                                {isManaged && (
                                  <span
                                    title="Mission Control and the OpenClaw setup wizard write this section themselves. You can still edit it."
                                    className="rounded-full bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
                                  >
                                    Managed automatically
                                  </span>
                                )}
                                {isSensitive && !showSensitive && (
                                  <Shield className="h-3 w-3 text-amber-500" />
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground/60">
                                {!configured
                                  ? "Not set up yet — open to configure it"
                                  : sectionHint?.help ||
                                    `${fieldCount} setting${fieldCount !== 1 ? "s" : ""}`}
                              </p>
                            </div>
                            {configured && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeSection(sectionKey);
                                }}
                                aria-label={`Remove section ${sectionKey}`}
                                title="Remove this whole section"
                                className="shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:bg-red-500/10 hover:text-red-500"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>

                          {isExpanded && (
                            <div className="border-t border-foreground/5 px-4 py-4">
                              {isManaged && (
                                <p className="mb-3 rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                                  OpenClaw writes this section itself (setup wizard, diagnostics,
                                  bookkeeping). Editing it is allowed but rarely necessary, and your
                                  values may be overwritten the next time OpenClaw updates them.
                                </p>
                              )}
                              {!configured ? (
                                <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-4 py-4">
                                  <p className="flex items-center gap-1.5 text-sm font-medium text-foreground/80">
                                    <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
                                    {label} is not configured yet
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {sectionHint?.help ||
                                      "Set it up here — no need to hand-edit openclaw.json."}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => createSection(sectionKey)}
                                    data-testid={`create-section-${sectionKey}`}
                                    className="mt-1 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                                  >
                                    <Plus className="h-3.5 w-3.5" />
                                    Set it up
                                  </button>
                                </div>
                              ) : (
                                <SectionFields
                                  sectionKey={sectionKey}
                                  sectionSchema={sectionSchema}
                                  sectionValue={sectionValue}
                                  hints={hints}
                                  showSensitive={showSensitive}
                                  onFieldChange={handleFieldChange}
                                  disabled={false}
                                  rawConfig={draft}
                                  onJumpToSection={jumpToSection}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {filteredSections.length === 0 && search && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/60">
            <Search className="h-6 w-6 mb-2" />
            <p className="text-sm">No settings match &ldquo;{search}&rdquo;</p>
            <button
              onClick={() => setSearch("")}
              className="mt-2 text-xs text-emerald-700 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200"
            >
              Clear search
            </button>
          </div>
        )}
      </SectionBody>

      <ConfigDiffPreview
        open={previewOpen}
        entries={changeEntries}
        restart={restartPlan}
        authTokenMint={authTokenMint}
        replacePaths={previewDiff.replacePaths}
        saving={saving}
        onBack={() => setPreviewOpen(false)}
        onConfirm={confirmSave}
      />

      <ConfigConflictDialog
        open={conflict !== null}
        message={conflict?.message ?? ""}
        analysis={conflictAnalysis}
        base={baseSnapshot}
        mine={(showRawJson ? rawParsed : draft) ?? {}}
        theirs={conflict?.remoteConfig ?? {}}
        hints={hints}
        busy={saving}
        onReloadTheirs={resolveWithTheirs}
        onRebase={resolveWithRebase}
        onCancel={() => setConflict(null)}
      />

      {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
    </SectionLayout>
    </FieldEnvContext.Provider>
    </ConfigLookupContext.Provider>
  );
}
