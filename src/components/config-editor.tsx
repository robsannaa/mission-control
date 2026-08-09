"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { LoadingState } from "@/components/ui/loading-state";

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

const READONLY_SECTIONS = new Set(["meta", "wizard", "diagnostics"]);
const SENSITIVE_SECTIONS = new Set(["env", "auth"]);
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
];

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

/** Set a nested value by dot-path (returns a new object) */
function setDeep(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const parts = path.split(".");
  const result = { ...obj };
  let cur: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const existing = cur[p];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      cur[p] = { ...(existing as Record<string, unknown>) };
    } else {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return result;
}

/** Build a nested object from a dot-path + value, for config.patch */
function buildPatchObject(
  path: string,
  value: unknown
): Record<string, unknown> {
  const parts = path.split(".");
  const result: Record<string, unknown> = {};
  let cur = result;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return result;
}

/** Get the label for a config path from hints */
function getLabel(
  hints: Record<string, UiHint>,
  path: string,
  fallback: string
): string {
  return hints[path]?.label || fallback;
}

function getHelp(hints: Record<string, UiHint>, path: string): string {
  return hints[path]?.help || "";
}

function isSensitivePath(
  hints: Record<string, UiHint>,
  path: string
): boolean {
  if (hints[path]?.sensitive) return true;
  const parts = path.split(".");
  if (SENSITIVE_SECTIONS.has(parts[0])) return true;
  const lastKey = parts[parts.length - 1] ?? "";
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(lastKey));
}

/** Infer field type from JSON Schema */
function inferFieldType(
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
function extractEnumValues(schema: JsonSchema | undefined): string[] {
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

/* ================================================================
   Toast
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
  if (sectionValue == null || typeof sectionValue !== "object") {
    return (
      <div className="text-xs text-muted-foreground/60 italic">
        No configuration set for this section.
      </div>
    );
  }

  const props = sectionSchema?.properties || {};
  const val = sectionValue as Record<string, unknown>;

  // In openclaw.json, default model lives under agents.defaults.model, not under top-level "models".
  // If we're in the Models section and that exists, show a cross-link so the UI matches the file.
  const agentsDefaultsModel =
    sectionKey === "models" && rawConfig?.agents && typeof rawConfig.agents === "object"
      ? (rawConfig.agents as Record<string, unknown>)?.defaults &&
        typeof (rawConfig.agents as Record<string, unknown>).defaults === "object"
        ? ((rawConfig.agents as Record<string, unknown>).defaults as Record<string, unknown>)?.model
        : undefined
      : undefined;

  // Get all keys: from schema + from value (to show unknown keys)
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
        const sensitive = isSensitivePath(hints, fullPath);
        const fieldType = inferFieldType(fieldSchema, hint);

        // Skip undefined values with no schema
        if (fieldValue === undefined && !fieldSchema) return null;

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
          <div key={key} className="space-y-1">
            <FieldLabel
              label={label}
              help={help}
              sensitive={sensitive && !showSensitive}
            />
            {renderField(
              fieldType,
              fieldValue,
              (v) => onFieldChange(fullPath, v),
              fieldSchema,
              hint,
              sensitive && !showSensitive,
              disabled
            )}
          </div>
        );
      })}
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
      return <FormViewEditInRawPlaceholder />;
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
  const props = schema?.properties || {};
  const allKeys = Array.from(
    new Set([...Object.keys(props), ...Object.keys(value)])
  );
  const [expanded, setExpanded] = useState(allKeys.length <= 4);

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
    <div className="rounded-lg border border-foreground/5 bg-foreground/5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        )}
        <span className="text-xs font-medium text-foreground/70">{label}</span>
        <span className="text-xs text-muted-foreground/60">
          {allKeys.length} field{allKeys.length !== 1 ? "s" : ""}
        </span>
      </button>
      {expanded && (
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
              const sensitive = isSensitivePath(hints, fullPath);
              const fieldType = inferFieldType(fieldSchema, hint);

              if (fieldValue === undefined && !fieldSchema) return null;

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
                <div key={key} className="space-y-1">
                  <FieldLabel
                    label={fLabel}
                    help={fHelp}
                    sensitive={sensitive && !showSensitive}
                  />
                  {renderField(
                    fieldType,
                    fieldValue,
                    (v) => onFieldChange(fullPath, v),
                    fieldSchema,
                    hint,
                    sensitive && !showSensitive,
                    disabled
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Normalize JSON string for dirty comparison (parse + re-stringify). */
function normalizedJsonString(str: string): string | null {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return null;
  }
}

/** Redact sensitive values for display when Secrets is off (raw view). */
function redactConfigForDisplay(
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

export function ConfigEditor() {
  const [rawConfig, setRawConfig] = useState<Record<string, unknown> | null>(null);
  const [baseHash, setBaseHash] = useState("");
  const [schema, setSchema] = useState<Record<string, JsonSchema>>({});
  const [hints, setHints] = useState<Record<string, UiHint>>({});
  const [fetchWarning, setFetchWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showSensitive, setShowSensitive] = useState(false);
  const [search, setSearch] = useState("");
  const [, setPendingChanges] = useState<
    Record<string, unknown>
  >({});
  const [showRawJson, setShowRawJson] = useState(false);
  /** Raw JSON editor content (when in raw view). Synced when entering raw view. */
  const [rawEditorValue, setRawEditorValue] = useState<string>("");

  // Track which sections have unsaved edits
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  // Sidebar "Jump to" group expand/collapse (folder-explorer style). Set = collapsed group names.
  const [sidebarGroupsCollapsed, setSidebarGroupsCollapsed] = useState<Set<string>>(new Set());

  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const hasInitialExpand = useRef(false);

  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  /* ── Fetch ─────────────────────────── */

  const fetchConfig = useCallback(async (opts?: { silent?: boolean }): Promise<Record<string, unknown> | null> => {
    if (!opts?.silent) {
      setLoading(true);
    }
    setFetchWarning(null);
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      const data = await res.json();
      // Canonical payload: { config: <resolved, raw values>, meta: { baseHash, schema, uiHints, warning?, degraded? } }.
      // Secrets arrive readable by design; the Secrets toggle redacts client-side only.
      const config = data?.config || {};
      const meta = data?.meta || {};
      const hasConfigPayload = Boolean(data?.config);
      if (!res.ok && !hasConfigPayload) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setRawConfig(config);
      setBaseHash(meta.baseHash || "");
      // Gateway config.schema returns { schema, uiHints }. schema.properties = top-level keys (agents, gateway, ...) matching openclaw.json.
      if (meta.schema?.properties) {
        setSchema(meta.schema.properties);
      } else {
        setSchema({});
      }
      setHints(meta.uiHints || {});
      if (meta.warning) setFetchWarning(String(meta.warning));
      setLoadError(null);
      setLoading(false);
      return typeof config === "object" && config !== null && !Array.isArray(config) ? config : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
      console.warn("Config fetch error:", err);
      setLoading(false);
      return null;
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  /* ── Section ordering ────────────── */
  // rawConfig = /api/config `config` payload (resolved openclaw.json shape). Sections = top-level keys (agents, gateway, channels, tools, ...).

  const sections = rawConfig
    ? Object.keys(rawConfig).sort((a, b) => {
        const aOrder = hints[a]?.order ?? 999;
        const bOrder = hints[b]?.order ?? 999;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.localeCompare(b);
      })
    : [];

  const filteredSections = search
    ? sections.filter((s) => {
        const label = hints[s]?.label || s;
        const matchSection =
          label.toLowerCase().includes(search.toLowerCase()) ||
          s.toLowerCase().includes(search.toLowerCase());
        if (matchSection) return true;
        // Also search field labels within the section
        return Object.keys(hints).some(
          (k) =>
            k.startsWith(s + ".") &&
            (hints[k].label?.toLowerCase().includes(search.toLowerCase()) ||
              k.toLowerCase().includes(search.toLowerCase()))
        );
      })
    : sections;

  /** Sections grouped by hint.group for easier scanning */
  const groupedSections = (() => {
    const map = new Map<string, string[]>();
    for (const key of filteredSections) {
      const group = (hints[key]?.group as string) || "General";
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(key);
    }
    const sorted = Array.from(map.entries()).sort(([a], [b]) => {
      const ai = GROUP_ORDER.indexOf(a);
      const bi = GROUP_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
    return sorted;
  })();

  // Expand first section on first load so the page isn't a wall of collapsed cards
  useEffect(() => {
    if (filteredSections.length > 0 && !hasInitialExpand.current) {
      hasInitialExpand.current = true;
      setExpanded((prev) => new Set([...prev, filteredSections[0]]));
    }
  }, [filteredSections]);

  const jumpToSection = useCallback((sectionKey: string) => {
    setExpanded((prev) => new Set([...prev, sectionKey]));
    requestAnimationFrame(() => {
      sectionRefs.current[sectionKey]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  /* ── Field change handler ─────────── */

  const handleFieldChange = useCallback(
    (path: string, value: unknown) => {
      if (!rawConfig) return;
      const newConfig = setDeep(rawConfig, path, value);
      setRawConfig(newConfig);
      setPendingChanges((prev) => ({
        ...prev,
        ...buildPatchObject(path, value),
      }));
      setDirtyPaths((prev) => new Set([...prev, path.split(".")[0]]));
    },
    [rawConfig]
  );

  const rawViewDirty =
    showRawJson &&
    rawConfig !== null &&
    (() => {
      const norm = normalizedJsonString(rawEditorValue);
      return norm !== null && norm !== JSON.stringify(rawConfig, null, 2);
    })();
  const hasDirty = dirtyPaths.size > 0 || rawViewDirty;

  /* ── Save ───────────────────────────── */

  const saveChanges = useCallback(async () => {
    const savingFromRaw = showRawJson && rawViewDirty;
    if (!savingFromRaw && !hasDirty) return;

    if (savingFromRaw) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawEditorValue) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setToast({ ok: false, msg: "Invalid JSON: root must be an object" });
          return;
        }
      } catch {
        setToast({ ok: false, msg: "Invalid JSON: check syntax" });
        return;
      }
    }

    setSaving(true);
    try {
      // Form view: send full rawConfig (openclaw.json shape) so all edits are persisted; gateway merges via config.patch.
      const body = savingFromRaw
        ? { raw: rawEditorValue, baseHash }
        : { patch: rawConfig ?? {}, baseHash };
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setToast({ ok: true, msg: "Configuration saved successfully" });
        setPendingChanges({});
        setDirtyPaths(new Set());
        requestRestart("Configuration was updated — some changes may require a restart.");
        const newConfig = await fetchConfig();
        if (savingFromRaw && newConfig) {
          setRawEditorValue(JSON.stringify(newConfig, null, 2));
        }
      } else {
        setToast({ ok: false, msg: data.error || "Save failed" });
      }
    } catch (err) {
      setToast({ ok: false, msg: String(err) });
    }
    setSaving(false);
  }, [hasDirty, baseHash, fetchConfig, showRawJson, rawEditorValue, rawViewDirty, rawConfig]);


  /* ── Discard ────────────────────── */

  const discardChanges = useCallback(async () => {
    setPendingChanges({});
    setDirtyPaths(new Set());
    const newConfig = await fetchConfig({ silent: true });
    if (showRawJson && newConfig) {
      setRawEditorValue(JSON.stringify(newConfig, null, 2));
    }
  }, [fetchConfig, showRawJson]);

  const toggleRawView = useCallback(() => {
    const next = !showRawJson;
    if (next && rawConfig) {
      setRawEditorValue(JSON.stringify(rawConfig, null, 2));
    }
    if (!next && rawEditorValue) {
      try {
        const parsed = JSON.parse(rawEditorValue) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setRawConfig(parsed);
        }
      } catch {
        // keep current rawConfig on invalid JSON when switching away
      }
    }
    setShowRawJson(next);
  }, [showRawJson, rawConfig, rawEditorValue]);

  const toggleSection = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* ── Loading state ─────────────── */

  if (loading) {
    return (
      <SectionLayout>
        <LoadingState label="Loading configuration..." size="lg" />
      </SectionLayout>
    );
  }

  if (!rawConfig) {
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

  /* ── Render ─────────────────────── */

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="flex items-center gap-2 text-xs">
            <Settings2 className="h-5 w-5 text-stone-700 dark:text-[#d6dce3]" />
            Configuration
          </span>
        }
        description="Edit your OpenClaw settings safely • Changes are validated before saving"
        descriptionClassName="text-sm text-muted-foreground"
        actions={
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 dark:border-[#2c343d] dark:bg-[#171a1d]">
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

      {/* Unsaved changes bar */}
      {hasDirty && (
        <div className="shrink-0 flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 md:px-6 dark:border-amber-500/20 dark:bg-amber-500/10">
          <Info className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <p className="flex-1 text-xs text-amber-800 dark:text-amber-200">
            You have unsaved changes in{" "}
            <strong>
              {[rawViewDirty && "raw JSON", ...Array.from(dirtyPaths)].filter(Boolean).join(", ")}
            </strong>
          </p>
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
            onClick={saveChanges}
            disabled={saving}
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
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      )}

      {/* Content */}
      <SectionBody width="wide" padding="compact" innerClassName="space-y-2">
        {showRawJson ? (
          /* Raw JSON view – editable when Secrets on, redacted when off */
          (() => {
            const redactedRaw =
              rawConfig != null
                ? JSON.stringify(redactConfigForDisplay(rawConfig, hints), null, 2)
                : "{}";
            const rawDisplayValue = showSensitive ? rawEditorValue : redactedRaw;
            return (
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-foreground/70">
                    Raw Configuration
                  </span>
                  <span className="text-xs text-muted-foreground/60">
                    {showSensitive
                      ? "Edit JSON directly; save with the button above when done"
                      : "Secrets hidden; turn on Secrets to view and edit."}
                  </span>
                </div>
                <div className="rounded-lg overflow-hidden border border-foreground/10 bg-zinc-800 dark:bg-zinc-800 min-h-96">
                  <MonacoEditor
                    height="70vh"
                    language="json"
                    value={rawDisplayValue}
                    onChange={showSensitive ? (v) => setRawEditorValue(v ?? "") : undefined}
                    theme={monacoTheme}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: "on",
                      wordWrap: "on",
                      formatOnPaste: showSensitive,
                      formatOnType: showSensitive,
                      scrollBeyondLastLine: false,
                      padding: { top: 12, bottom: 12 },
                      bracketPairColorization: { enabled: true },
                      folding: true,
                      semanticHighlighting: { enabled: true },
                      readOnly: !showSensitive,
                    } as unknown as NonNullable<React.ComponentProps<typeof MonacoEditor>["options"]>}
                  />
                </div>
              </div>
            );
          })()
        ) : (
          /* Form view: sidebar nav + grouped sections */
          <div className="flex gap-6">
            {/* Sticky sidebar: Jump to section */}
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
                          const isDirty = dirtyPaths.has(sectionKey);
                          return (
                            <li key={sectionKey}>
                              <button
                                type="button"
                                onClick={() => jumpToSection(sectionKey)}
                                className={cn(
                                  "w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                                  isDirty
                                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                    : "text-foreground/80 hover:bg-foreground/10 hover:text-foreground"
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
              {groupedSections.map(([groupName, sectionKeys]) => (
                <div key={groupName}>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-0.5">
                    {groupName}
                  </h2>
                  <div className="space-y-2">
                    {sectionKeys.map((sectionKey) => {
                      const isExpanded = expanded.has(sectionKey);
                      const isReadonly = READONLY_SECTIONS.has(sectionKey);
                      const isSensitive = SENSITIVE_SECTIONS.has(sectionKey);
                      const isDirty = dirtyPaths.has(sectionKey);
                      const sectionHint = hints[sectionKey];
                      const label = sectionHint?.label || sectionKey;
                      const icon = SECTION_ICONS[sectionKey] || "📦";
                      const sectionSchema = schema[sectionKey];
                      const sectionValue = rawConfig[sectionKey];

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
                          className={cn(
                            "rounded-xl border transition-colors",
                            isDirty
                              ? "border-emerald-500/30 bg-emerald-500/10"
                              : "border-stone-200 bg-white dark:border-[#2c343d] dark:bg-[#171a1d]"
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
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-foreground/90">
                                  {label}
                                </span>
                                {isDirty && (
                                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                                    Modified
                                  </span>
                                )}
                                {isReadonly && (
                                  <span className="rounded-full bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
                                    Read-only
                                  </span>
                                )}
                                {isSensitive && !showSensitive && (
                                  <Shield className="h-3 w-3 text-amber-500" />
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground/60">
                                {sectionHint?.help || `${fieldCount} setting${fieldCount !== 1 ? "s" : ""}`}
                              </p>
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="border-t border-foreground/5 px-4 py-4">
                              <SectionFields
                                sectionKey={sectionKey}
                                sectionSchema={sectionSchema}
                                sectionValue={sectionValue}
                                hints={hints}
                                showSensitive={showSensitive}
                                onFieldChange={handleFieldChange}
                                disabled={isReadonly}
                                rawConfig={rawConfig}
                                onJumpToSection={jumpToSection}
                              />
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

      {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
    </SectionLayout>
  );
}
