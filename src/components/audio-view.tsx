"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { requestRestart } from "@/lib/restart-store";
import {
  Volume2,
  Play,
  Pause,
  Mic,
  Radio,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Check,
  AlertTriangle,
  Headphones,
  Settings2,
  Speaker,
  Waves,
  Zap,
  Globe,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";

/* ── Types ────────────────────────────────────────── */

type TtsStatus = {
  enabled: boolean;
  auto: string;
  provider: string;
  fallbackProvider?: string;
  fallbackProviders?: string[];
  prefsPath?: string;
  hasOpenAIKey?: boolean;
  hasElevenLabsKey?: boolean;
  edgeEnabled?: boolean;
};

type TtsProvider = {
  id: string;
  name: string;
  configured: boolean;
  models: string[];
  voices?: string[];
  supportsApiKey?: boolean;
  authState?: "ready" | "missing" | "builtin" | "external";
  authLabel?: string;
  authSource?: string | null;
  authNote?: string | null;
  authLocation?: "config-tts" | "config-env" | "process-env" | "runtime" | "builtin" | "missing" | null;
  canManageKey?: boolean;
  canRemoveKey?: boolean;
  removeMode?: "config-tts" | "config-env" | null;
  envKey?: string | null;
};

type TtsProvidersData = {
  providers: TtsProvider[];
  active: string;
};

type TalkConfig = {
  voiceId?: string;
  voiceAliases?: Record<string, string>;
  modelId?: string;
  outputFormat?: string;
  interruptOnSpeech?: boolean;
};

type AudioConfig = {
  enabled?: boolean;
  maxBytes?: number;
  scope?: Record<string, unknown>;
  models?: AudioModel[];
};

type AudioModel = {
  type?: string;
  provider?: string;
  model?: string;
  command?: string;
  args?: string[];
  timeoutSeconds?: number;
  capabilities?: string[];
};

type TtsPrefs = {
  enabled?: boolean;
  provider?: string;
  maxLength?: number;
  summarize?: boolean;
};

type Toast = { message: string; type: "success" | "error" };

type AudioFullState = {
  status: TtsStatus;
  providers: TtsProvidersData;
  config: {
    tts: { resolved: Record<string, unknown>; parsed: Record<string, unknown> | null };
    talk: { resolved: TalkConfig; parsed: TalkConfig | null };
    audioUnderstanding: {
      resolved: AudioConfig;
      parsed: Record<string, unknown> | null;
    };
  };
  prefs: TtsPrefs | null;
};

/* ── Helpers ──────────────────────────────────────── */

const PROVIDER_ICONS: Record<string, string> = {
  openai: "🤖",
  elevenlabs: "🔊",
  edge: "🌐",
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-success-bg text-success-fg border-success-border",
  elevenlabs: "bg-muted-foreground/15 text-fg-secondary border-border-strong",
  edge: "bg-info-bg text-info-fg border-info-border",
};

const AUTO_MODES = [
  { value: "off", label: "Off", desc: "No automatic TTS" },
  { value: "always", label: "Always", desc: "All replies spoken" },
  { value: "inbound", label: "Inbound", desc: "Voice-reply to voice messages" },
  { value: "tagged", label: "Tagged", desc: "Only /tts tagged messages" },
];

/* ── Toast Component ─────────────────────────────── */

function ToastBar({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className={cn(
        "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-xl backdrop-blur-sm",
        toast.type === "success"
          ? "border-success-border bg-success-bg text-success-fg"
          : "border-danger-border bg-danger-bg text-danger-fg"
      )}
    >
      <div className="flex items-center gap-2">
        {toast.type === "success" ? (
          <Check className="h-4 w-4" />
        ) : (
          <AlertTriangle className="h-4 w-4" />
        )}
        {toast.message}
      </div>
    </div>
  );
}

/* ── Provider Card ───────────────────────────────── */

function ProviderCard({
  provider,
  isActive,
  onSelect,
  loading,
  onTest,
  onSaveKey,
  onRemoveKey,
}: {
  provider: TtsProvider;
  isActive: boolean;
  onSelect: () => void;
  loading: boolean;
  onTest: (provider: string, voice?: string) => void;
  onSaveKey: (provider: string, apiKey: string) => Promise<boolean>;
  onRemoveKey: (
    provider: string,
    mode: "config-tts" | "config-env",
    envKey?: string,
  ) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<string>("");
  const [draftKey, setDraftKey] = useState("");
  const color = PROVIDER_COLORS[provider.id] || "bg-muted-foreground/15 text-muted-foreground border-border-strong/20";
  const icon = PROVIDER_ICONS[provider.id] || "🔈";
  const availableVoices = provider.voices || [];
  const activeVoice =
    selectedVoice && availableVoices.includes(selectedVoice)
      ? selectedVoice
      : (availableVoices[0] ?? "");
  const authBadgeClasses =
    provider.authState === "ready" || provider.authState === "builtin"
      ? "border border-success-border bg-success-bg text-success-fg"
      : provider.authState === "external"
        ? "border border-info-border bg-info-bg text-info-fg"
        : "border border-warning-border bg-warning-bg text-warning-fg";

  return (
    <div
      className={cn(
        "rounded-xl border transition-all",
        isActive
          ? "border-success-border bg-success-bg"
          : "border-foreground/10 bg-foreground/5 hover:border-foreground/15"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="text-base">{icon}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">
              {provider.name}
            </span>
            {isActive && (
              <span className="rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-success-fg">
                Active
              </span>
            )}
            {provider.authLabel && (
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wider", authBadgeClasses)}>
                {provider.authLabel}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
            {provider.models.length > 0 && (
              <span>
                {provider.models.length} model{provider.models.length !== 1 ? "s" : ""}
              </span>
            )}
            {provider.voices && (
              <span>
                {provider.voices.length} voice{provider.voices.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isActive && provider.configured && (
            <button
              onClick={onSelect}
              disabled={loading}
              className="rounded-lg border border-foreground/10 bg-background px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : (
                "Set Active"
              )}
            </button>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-fg-secondary"
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded: Models & Voices */}
      {expanded && (
        <div className="border-t border-foreground/5 px-4 py-3 space-y-3">
          {provider.canManageKey && (
            <div className="rounded-lg border border-foreground/10 bg-muted/40 p-3">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Authentication
              </p>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={cn("rounded-full px-2 py-0.5 font-semibold uppercase tracking-wider", authBadgeClasses)}>
                    {provider.authLabel || "Needs TTS key"}
                  </span>
                  {provider.authSource && (
                    <span className="text-muted-foreground">{provider.authSource}</span>
                  )}
                </div>
                {provider.authNote && (
                  <p className="text-xs text-muted-foreground">{provider.authNote}</p>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    value={draftKey}
                    onChange={(e) => setDraftKey(e.target.value)}
                    placeholder={provider.configured ? "Paste a new API key to replace the current one" : "Paste API key"}
                    aria-label={`API key for ${provider.name || provider.id}`}
                    className="flex-1 rounded-md border border-foreground/10 bg-background px-3 py-2 text-xs text-foreground outline-none transition-colors focus:border-success-border"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await onSaveKey(provider.id, draftKey);
                      if (ok) setDraftKey("");
                    }}
                    disabled={loading || !draftKey.trim()}
                    className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-xs font-medium text-success-fg transition-colors hover:bg-success-bg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Save key
                  </button>
                  {provider.canRemoveKey && provider.removeMode && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!provider.removeMode) return;
                        void onRemoveKey(provider.id, provider.removeMode, provider.envKey || undefined);
                      }}
                      disabled={loading}
                      className="rounded-md border border-foreground/10 bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Remove saved key
                    </button>
                  )}
                </div>
                {provider.authState === "external" && (
                  <p className="text-xs text-muted-foreground">
                    This key is managed outside Mission Control. Saving a key here gives TTS its own local configuration.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Models */}
          {provider.models.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
                Models
              </p>
              <div className="flex flex-wrap gap-1.5">
                {provider.models.map((m) => (
                  <span
                    key={m}
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-xs",
                      color
                    )}
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Voices */}
          {provider.voices && provider.voices.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
                Voices
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={activeVoice}
                  onChange={(e) => {
                    const voice = e.target.value;
                    setSelectedVoice(voice);
                    if (provider.configured && voice) {
                      onTest(provider.id, voice);
                    }
                  }}
                  aria-label="Select voice"
                  className="flex-1 rounded-md border border-foreground/10 bg-muted px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-success-border"
                >
                  {provider.voices.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => onTest(provider.id, activeVoice || undefined)}
                  disabled={!provider.configured}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Play className="h-3 w-3" />
                  Play
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Selecting a voice plays an instant sample.
              </p>
            </div>
          )}

          {/* Test button */}
          {provider.configured && (
            <div className="pt-1">
              <button
                onClick={() => onTest(provider.id, activeVoice || undefined)}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Play className="h-3.5 w-3.5" />
                Test {provider.name}
                {activeVoice && ` · ${activeVoice}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Audio Player ────────────────────────────────── */

function AudioPlayer({
  result,
  autoPlay = true,
}: {
  result: { provider: string; format: string; path: string; voiceCompatible: boolean };
  autoPlay?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioUrl = `/api/audio?scope=stream&path=${encodeURIComponent(result.path)}`;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onCanPlay = () => {
      // Auto-play when audio is ready
      if (autoPlay) {
        audio.play().then(() => setPlaying(true)).catch(() => {});
      }
    };
    const onTimeUpdate = () => {
      if (audio.duration) setProgress(audio.currentTime / audio.duration);
    };
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => {
      setPlaying(false);
      setProgress(1);
    };
    const onError = () => {};

    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      // Stop audio when unmounting
      audio.pause();
    };
  }, [autoPlay]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(console.error);
      setPlaying(true);
    }
  };

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    setProgress(pct);
  };

  const formatTime = (s: number) => {
    if (!s || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="rounded-xl border border-success-border bg-success-bg p-4 space-y-3">
      <audio ref={audioRef} src={audioUrl} preload="auto" />

      <div className="flex items-center gap-2 text-sm font-medium text-success-fg">
        <Check className="h-4 w-4" />
        Audio Generated Successfully
      </div>

      {/* Player controls */}
      <div className="flex items-center gap-3 rounded-lg border border-success-border bg-muted px-3 py-3">
        <button
          onClick={togglePlay}
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
            playing
              ? "bg-success text-black hover:bg-success"
              : "bg-success-bg text-success-fg hover:bg-success-bg"
          )}
        >
          {playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4 ml-0.5" />
          )}
        </button>

        <div className="flex-1 space-y-1">
          {/* Progress bar */}
          <div
            className="group relative h-2 cursor-pointer rounded-full bg-foreground/10"
            onClick={seekTo}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-success transition-all"
              style={{ width: `${progress * 100}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-success opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
              style={{ left: `calc(${progress * 100}% - 6px)` }}
            />
          </div>

          {/* Time */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatTime(progress * duration)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <ConfigField label="Provider" value={result.provider} />
        <ConfigField label="Format" value={result.format} />
        <ConfigField
          label="Voice Compatible"
          value={result.voiceCompatible ? "Yes" : "No"}
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Saved to:</span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground truncate">
          {result.path}
        </code>
      </div>
    </div>
  );
}

/* ── TTS Test Panel ─────────────────────────────── */

function TtsTestPanel({
  onTest,
  testing,
  providers,
  activeProvider,
}: {
  onTest: (text: string, provider?: string, voice?: string) => void;
  testing: boolean;
  providers: TtsProvider[];
  activeProvider?: string;
}) {
  const getDefaultSample = useCallback(() => {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    return `${greeting}. This is a voice sample for OpenClaw.`;
  }, []);
  const [text, setText] = useState(() => getDefaultSample());
  const [providerChoice, setProviderChoice] = useState(activeProvider || "");
  const [voiceChoice, setVoiceChoice] = useState("");

  const configuredProviders = providers.filter((p) => p.configured);
  const effectiveProviderId =
    configuredProviders.find((p) => p.id === providerChoice)?.id ||
    configuredProviders.find((p) => p.id === activeProvider)?.id ||
    configuredProviders[0]?.id ||
    "";
  const effectiveProvider = providers.find((p) => p.id === effectiveProviderId) || null;
  const availableVoices = effectiveProvider?.voices || [];
  const effectiveVoice =
    voiceChoice && availableVoices.includes(voiceChoice)
      ? voiceChoice
      : (availableVoices[0] ?? "");

  const samplePresets = [
    "Good morning. This is a voice sample for OpenClaw.",
    "Quick update: your dashboard is online, audio is configured, and responses are ready.",
    "Let's test pacing, clarity, and tone. If this sounds natural, this voice is a strong fit.",
    "Heads up: your assistant can now respond in voice with low latency and clean playback.",
  ];

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Headphones className="h-3.5 w-3.5 text-fg-secondary" />
        Voice Sample Lab
      </div>

      <div className="flex flex-wrap gap-1.5">
        {samplePresets.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setText(preset)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs leading-tight transition-colors",
              text === preset
                ? "border-border-strong bg-muted-foreground/15 text-fg-secondary"
                : "border-foreground/10 bg-muted text-muted-foreground hover:text-fg-secondary"
            )}
          >
            {preset.length > 40 ? `${preset.slice(0, 40)}…` : preset}
          </button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        aria-label="Text to convert to speech"
        className="w-full rounded-lg border border-foreground/10 bg-muted px-3 py-2 text-sm text-foreground placeholder-fg-secondary outline-none focus:border-border-strong resize-none"
        placeholder="Enter text to convert to speech..."
      />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Provider
          </p>
          <select
            value={effectiveProviderId}
            onChange={(e) => {
              const nextProvider = e.target.value;
              setProviderChoice(nextProvider);
              setVoiceChoice("");
              const nextVoices = providers.find((p) => p.id === nextProvider)?.voices || [];
              const firstVoice = nextVoices[0];
              if (nextProvider) {
                onTest(text, nextProvider, firstVoice);
              }
            }}
            aria-label="TTS provider"
            className="w-full rounded-md border border-foreground/10 bg-muted px-2.5 py-2 text-xs text-foreground outline-none focus:border-border-strong"
          >
            {configuredProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Voice
          </p>
          <select
            value={effectiveVoice}
            onChange={(e) => {
              const nextVoice = e.target.value;
              setVoiceChoice(nextVoice);
              if (effectiveProviderId && nextVoice) {
                onTest(text, effectiveProviderId, nextVoice);
              }
            }}
            disabled={!effectiveProviderId || availableVoices.length === 0}
            aria-label="TTS voice"
            className="w-full rounded-md border border-foreground/10 bg-muted px-2.5 py-2 text-xs text-foreground outline-none focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {availableVoices.length > 0 ? (
              availableVoices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))
            ) : (
              <option value="">No voices available</option>
            )}
          </select>
        </div>
      </div>

      <button
        onClick={() => onTest(text, effectiveProviderId || undefined, effectiveVoice || undefined)}
        disabled={testing || !text.trim() || !effectiveProviderId}
        className="flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {testing ? (
          <>
            <span className="inline-flex items-center gap-0.5">
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
            </span>
            Generating audio...
          </>
        ) : (
          <>
            <Volume2 className="h-3.5 w-3.5" />
            Generate & Play
          </>
        )}
      </button>
    </div>
  );
}

/* ── Talk Mode Section ───────────────────────────── */

function TalkModeSection({
  config,
  talkSectionExists,
  onEnableTalk,
  enabling,
  onTestTalk,
  testingTalk,
}: {
  config: TalkConfig;
  /** True when the talk section exists in config (even if empty), so we show as enabled after "Enable Talk Mode" */
  talkSectionExists?: boolean;
  onEnableTalk?: () => Promise<void>;
  enabling?: boolean;
  onTestTalk?: (message: string) => Promise<void>;
  testingTalk?: boolean;
}) {
  const [testMessage, setTestMessage] = useState("");
  const [listening, setListening] = useState(false);
  const hasConfig =
    (config && Object.keys(config).length > 0) || talkSectionExists === true;

  const startListening = useCallback(() => {
    type BrowserSpeechRecognition = {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    type BrowserSpeechRecognitionEvent = {
      results?: ArrayLike<ArrayLike<{ transcript?: string }>>;
    };
    type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

    const speechRecognitionCtor =
      typeof window !== "undefined" &&
      (window as unknown as {
        SpeechRecognition?: BrowserSpeechRecognitionCtor;
        webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
      }).SpeechRecognition;
    const webkitSpeechRecognitionCtor =
      typeof window !== "undefined" &&
      (window as unknown as {
        webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
      }).webkitSpeechRecognition;
    const Recognition = speechRecognitionCtor || webkitSpeechRecognitionCtor;
    if (!Recognition) {
      return;
    }
    const rec = new Recognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    setListening(true);
    rec.onresult = (event: BrowserSpeechRecognitionEvent) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) setTestMessage((prev) => (prev ? `${prev} ${transcript}` : transcript).trim());
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }, []);

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Mic className="h-3.5 w-3.5 text-success-fg" />
        Talk Mode
        <span className="text-xs text-muted-foreground font-normal">(macOS / iOS / Android)</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Continuous voice conversation loop: Listen → Transcribe → Respond → Speak.
        Uses ElevenLabs for real-time streaming playback.{" "}
        <a
          href="https://docs.openclaw.ai/nodes/talk#talk-mode"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:underline"
        >
          Docs
        </a>
      </p>

      {hasConfig ? (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ConfigField label="Voice ID" value={config.voiceId || "auto-detect"} />
            <ConfigField label="Model" value={config.modelId || "eleven_v3"} />
            <ConfigField label="Output Format" value={config.outputFormat || "pcm_44100 (macOS)"} />
            <ConfigField label="Interrupt on Speech" value={config.interruptOnSpeech !== false ? "Enabled" : "Disabled"} />
          </div>
          {config.voiceAliases && Object.keys(config.voiceAliases).length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
                Voice Aliases
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(config.voiceAliases).map(([alias, id]) => (
                  <span
                    key={alias}
                    className="rounded-md border border-success-border bg-success-bg px-2 py-0.5 text-xs text-success-fg"
                    title={id}
                  >
                    {alias}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Test Talk in browser */}
          {onTestTalk && (
            <div className="mt-3 rounded-lg border border-success-border bg-success-bg p-3 space-y-2">
              <p className="text-xs font-medium text-foreground">Test in browser</p>
              <p className="text-xs text-muted-foreground">
                Send a message to the agent and hear the reply in your Talk voice.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void onTestTalk(testMessage)}
                  placeholder="Say something to the agent…"
                  aria-label="Test message for Talk"
                  className="flex-1 min-w-0 rounded-lg border border-foreground/10 bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-success-border"
                  disabled={testingTalk}
                />
                <div className="flex gap-2">
                  {typeof window !== "undefined" &&
                    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) && (
                    <button
                      type="button"
                      onClick={startListening}
                      disabled={testingTalk || listening}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                        listening
                          ? "border-warning-border bg-warning-bg text-warning-fg"
                          : "border-foreground/15 bg-muted/50 text-foreground hover:bg-muted"
                      )}
                      title="Use microphone"
                    >
                      <Mic className={cn("h-4 w-4", listening && "animate-pulse")} />
                      {listening ? "Listening…" : "Mic"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onTestTalk(testMessage)}
                    disabled={testingTalk || !testMessage.trim()}
                    className="inline-flex items-center gap-2 rounded-lg border border-success-border bg-success-bg px-4 py-2 text-sm font-medium text-success-fg transition-colors hover:bg-success-bg disabled:opacity-50"
                  >
                    {testingTalk ? (
                      <>
                        <span className="inline-flex items-center gap-0.5">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                        </span>
                        Sending…
                      </>
                    ) : (
                      <>
                        <Volume2 className="h-4 w-4" />
                        Send & hear reply
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-foreground/10 bg-muted/50 px-4 py-6 text-center">
          <Mic className="mx-auto h-8 w-8 text-fg-subtle mb-2" />
          <p className="text-xs text-muted-foreground">
            Talk Mode is not configured yet.
          </p>
          <p className="text-xs text-fg-subtle mt-1">
            Add a <code className="rounded bg-foreground/10 px-1 py-0.5 text-xs">talk</code> section to enable voice conversation. Set <strong className="text-fg-secondary">voiceId</strong> and <strong className="text-fg-secondary">apiKey</strong> in Config → Raw or after enabling.
          </p>
          {onEnableTalk && (
            <button
              type="button"
              onClick={() => void onEnableTalk()}
              disabled={enabling}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-success-border bg-success-bg px-4 py-2 text-sm font-medium text-success-fg transition-colors hover:bg-success-bg disabled:opacity-50"
            >
              {enabling ? (
                <>
                  <span className="inline-flex items-center gap-0.5">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                  Enabling…
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4" />
                  Enable Talk Mode
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Usage info */}
      <div className="rounded-lg border border-foreground/5 bg-muted/50 px-3 py-2.5">
        <p className="text-xs font-medium text-muted-foreground mb-1">How it works</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { icon: "🎤", label: "Listen", desc: "Detects speech" },
            { icon: "📝", label: "Transcribe", desc: "Speech → text" },
            { icon: "🧠", label: "Think", desc: "Agent responds" },
            { icon: "🔊", label: "Speak", desc: "ElevenLabs TTS" },
          ].map((step) => (
            <div key={step.label} className="text-center">
              <span className="text-sm">{step.icon}</span>
              <p className="text-xs font-medium text-fg-secondary mt-0.5">{step.label}</p>
              <p className="text-xs text-fg-subtle">{step.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Config Field ────────────────────────────────── */

function ConfigField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-foreground/5 bg-muted/50 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
        {label}
      </p>
      <p className="text-sm text-fg-secondary mt-0.5 font-mono">{value}</p>
    </div>
  );
}

/* AutoModeSelector is now inlined in the main view */

/* ── TTS Settings Panel ──────────────────────────── */

function TtsSettingsPanel({
  status,
  prefs,
  onUpdateConfig,
  loading,
}: {
  status: TtsStatus;
  prefs: TtsPrefs | null;
  onUpdateConfig: (section: string, config: Record<string, unknown>) => void;
  loading: boolean;
}) {
  const [summaryThreshold, setSummaryThreshold] = useState(
    prefs?.maxLength?.toString() || "1500"
  );
  const [summarize, setSummarize] = useState(prefs?.summarize !== false);

  // Re-sync local state when props change after a refetch
  useEffect(() => {
    queueMicrotask(() => {
      setSummaryThreshold(prefs?.maxLength?.toString() || "1500");
      setSummarize(prefs?.summarize !== false);
    });
  }, [prefs]);

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
        TTS Settings
      </div>

      {/* Fallback chain */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
          Provider Fallback Chain
        </p>
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-border-strong bg-muted-foreground/15 px-2 py-0.5 text-xs font-medium text-fg-secondary">
            {status.provider}
          </span>
          {status.fallbackProviders?.map((fp) => (
            <div key={fp} className="flex items-center gap-2">
              <span className="text-xs text-fg-subtle">→</span>
              <span className="rounded-md border border-foreground/10 bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground">
                {fp}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* API Key status */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
          API Keys
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[
            { name: "OpenAI", has: status.hasOpenAIKey },
            { name: "ElevenLabs", has: status.hasElevenLabsKey },
            { name: "Edge TTS", has: status.edgeEnabled },
          ].map((k) => (
            <div
              key={k.name}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs",
                k.has
                  ? "border-success-border bg-success-bg text-success-fg"
                  : "border-foreground/10 bg-foreground/5 text-fg-subtle"
              )}
            >
              {k.has ? (
                <Check className="h-3 w-3" />
              ) : (
                <X className="h-3 w-3" />
              )}
              {k.name}
            </div>
          ))}
        </div>
      </div>

      {/* Summary settings */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Auto-Summarize Long Replies
          </p>
          <button
            onClick={() => {
              const newVal = !summarize;
              setSummarize(newVal);
              onUpdateConfig("tts", {
                auto: status.auto,
                summarize: newVal,
                maxTextLength: parseInt(summaryThreshold) || 1500,
              });
            }}
            disabled={loading}
            className={cn(
              "relative h-5 w-9 rounded-full transition-colors",
              summarize ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-card transition-transform",
                summarize ? "left-5" : "left-0.5"
              )}
            />
          </button>
        </div>
        {summarize && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Threshold:</span>
            <input
              type="number"
              value={summaryThreshold}
              onChange={(e) => setSummaryThreshold(e.target.value)}
              onBlur={() => {
                const val = parseInt(summaryThreshold, 10) || 1500;
                if (val > 0 && val <= 100000) {
                  onUpdateConfig("tts", {
                    auto: status.auto,
                    summarize,
                    maxTextLength: val,
                  });
                }
              }}
              className="w-24 rounded-md border border-foreground/10 bg-muted px-2 py-1 text-xs text-fg-secondary outline-none"
              placeholder="1500"
              aria-label="Summary threshold (characters)"
            />
            <span className="text-xs text-fg-subtle">chars</span>
          </div>
        )}
      </div>

      {/* Output format info */}
      <div className="rounded-lg border border-foreground/5 bg-muted/50 px-3 py-2.5">
        <p className="text-xs font-medium text-muted-foreground mb-1">Output Formats</p>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p><span className="text-muted-foreground">Telegram:</span> Opus voice note (48kHz/64kbps)</p>
          <p><span className="text-muted-foreground">Other channels:</span> MP3 (44.1kHz/128kbps)</p>
          <p><span className="text-muted-foreground">Edge TTS:</span> audio-24khz-48kbitrate-mono-mp3</p>
        </div>
      </div>
    </div>
  );
}

/* ── Main AudioView ──────────────────────────────── */

export function AudioView() {
  const [data, setData] = useState<AudioFullState | null>(null);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [apiDegraded, setApiDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [talkEnabling, setTalkEnabling] = useState(false);
  const [testingTalk, setTestingTalk] = useState(false);
  const [slashCommandsOpen, setSlashCommandsOpen] = useState(false);
  const [gatewayRpcOpen, setGatewayRpcOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [testResult, setTestResult] = useState<{
    provider: string;
    format: string;
    path: string;
    voiceCompatible: boolean;
    key: number; // force remount for auto-play
  } | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewCacheRef = useRef(
    new Map<
      string,
      { provider: string; format: string; path: string; voiceCompatible: boolean }
    >()
  );

  /* ── Fetch ─────────────── */

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/audio");
      if (!res.ok) throw new Error("Failed");
      const json = (await res.json()) as AudioFullState & {
        warning?: unknown;
        degraded?: unknown;
      };
      setApiWarning(
        typeof json.warning === "string" && json.warning.trim()
          ? json.warning.trim()
          : null
      );
      setApiDegraded(Boolean(json.degraded));
      setData(json);
    } catch (err) {
      console.error("Audio fetch error:", err);
      setApiWarning(err instanceof Error ? err.message : String(err));
      setApiDegraded(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    return () => {
      previewAbortRef.current?.abort();
    };
  }, []);

  /* ── Actions ───────────── */

  const setAutoMode = useCallback(
    async (mode: string) => {
      // Optimistic update
      setData((prev) =>
        prev ? { ...prev, status: { ...prev.status, auto: mode } } : prev
      );
      setActionLoading(true);
      try {
        const res = await fetch("/api/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-auto-mode", mode }),
        });
        const json = await res.json();
        if (json.ok) {
          setToast({
            message: mode === "off" ? "Auto-TTS turned off" : `Auto-TTS set to "${mode}". Refreshing after restart…`,
            type: "success",
          });
          requestRestart("TTS auto-mode was changed.");
          // Optimistic update already set status.auto; delay refetch so restarted gateway is up
          await new Promise((r) => setTimeout(r, 2500));
          await fetchData();
        } else {
          setToast({ message: json.error || "Failed to update", type: "error" });
          await fetchData(); // revert by refetching
        }
      } catch {
        setToast({ message: "Could not reach the gateway", type: "error" });
        await fetchData();
      } finally {
        setActionLoading(false);
      }
    },
    [fetchData]
  );

  const setProvider = useCallback(
    async (provider: string) => {
      // Optimistic update
      setData((prev) =>
        prev
          ? {
              ...prev,
              status: { ...prev.status, provider },
              providers: { ...prev.providers, active: provider },
            }
          : prev
      );
      setActionLoading(true);
      try {
        const res = await fetch("/api/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-provider", provider }),
        });
        const json = await res.json();
        if (json.ok) {
          setToast({ message: `Switched to ${provider}`, type: "success" });
          requestRestart("TTS provider was changed.");
          await fetchData();
        } else {
          setToast({ message: json.error || "Failed", type: "error" });
          await fetchData(); // Revert by refetching
        }
      } catch (err) {
        setToast({ message: String(err), type: "error" });
        await fetchData();
      } finally {
        setActionLoading(false);
      }
    },
    [fetchData]
  );

  const testTts = useCallback(
    async (text: string, provider?: string, voice?: string) => {
      const cleanText = text.trim() || "This is a voice sample for OpenClaw.";
      const activeProvider = provider || data?.providers.active || data?.status.provider || "auto";
      const cacheKey = `${activeProvider}::${voice || "default"}::${cleanText}`;
      const cached = previewCacheRef.current.get(cacheKey);
      if (cached) {
        setTestResult({ ...cached, key: Date.now() });
        setToast({
          message: `Playing cached sample`,
          type: "success",
        });
        return;
      }

      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;

      setTesting(true);
      setTestResult(null);
      try {
        const body: Record<string, unknown> = { action: "test", text: cleanText };
        if (provider) body.provider = provider;
        if (voice) body.voice = voice;
        const res = await fetch("/api/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const json = await res.json();
        if (json.ok) {
          const result = {
            provider: json.provider || "unknown",
            format: json.outputFormat || "mp3",
            path: json.audioPath || "",
            voiceCompatible: json.voiceCompatible ?? false,
          };
          previewCacheRef.current.set(cacheKey, result);
          setTestResult({ ...result, key: Date.now() });
          setToast({
            message: `Voice sample ready`,
            type: "success",
          });
        } else {
          setToast({ message: json.error || "Generation failed", type: "error" });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setToast({ message: String(err), type: "error" });
      } finally {
        if (previewAbortRef.current === controller) {
          previewAbortRef.current = null;
          setTesting(false);
        }
      }
    },
    [data]
  );

  const testTalkInBrowser = useCallback(
    async (userMessage: string) => {
      const msg = userMessage.trim();
      if (!msg) return;
      const talkResolved = data?.config?.talk?.resolved as { voiceId?: string } | undefined;
      const voiceId = talkResolved?.voiceId;
      setTestingTalk(true);
      setTestResult(null);
      try {
        const chatRes = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: msg }],
            agentId: "main",
          }),
        });
        const reply = await chatRes.text();
        const replyTrimmed = reply?.trim();
        if (!replyTrimmed) {
          setToast({ message: "No reply from agent", type: "error" });
          return;
        }
        await testTts(replyTrimmed, "elevenlabs", voiceId || undefined);
      } catch (err) {
        setToast({ message: err instanceof Error ? err.message : "Talk test failed", type: "error" });
      } finally {
        setTestingTalk(false);
      }
    },
    [data?.config?.talk?.resolved, testTts]
  );

  const updateConfig = useCallback(
    async (section: string, config: Record<string, unknown>) => {
      setActionLoading(true);
      try {
        const res = await fetch("/api/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update-config", section, config }),
        });
        const json = await res.json();
        if (json.ok) {
          setToast({ message: `Updated ${section} config`, type: "success" });
          requestRestart("Audio provider configuration was updated.");
          // Re-fetch so everything syncs from the source of truth
          await fetchData();
        } else {
          setToast({ message: json.error || "Failed", type: "error" });
          await fetchData(); // revert
        }
      } catch (err) {
        setToast({ message: String(err), type: "error" });
        await fetchData();
      } finally {
        setActionLoading(false);
      }
    },
    [fetchData]
  );

  const saveProviderKey = useCallback(
    async (provider: string, apiKey: string) => {
      const trimmed = apiKey.trim();
      if (!trimmed) {
        setToast({ message: "Paste an API key first", type: "error" });
        return false;
      }

      setActionLoading(true);
      try {
        const res = await fetch("/api/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-provider-key", provider, apiKey: trimmed }),
        });
        const json = await res.json();
        if (json.ok) {
          setToast({ message: `${provider} key saved`, type: "success" });
          requestRestart(`${provider} audio credentials were updated.`);
          await fetchData();
          return true;
        }
        setToast({ message: json.error || "Failed to save key", type: "error" });
        await fetchData();
        return false;
      } catch (err) {
        setToast({ message: String(err), type: "error" });
        await fetchData();
        return false;
      } finally {
        setActionLoading(false);
      }
    },
    [fetchData]
  );

  const removeProviderKey = useCallback(
    async (
      provider: string,
      mode: "config-tts" | "config-env",
      envKey?: string,
    ) => {
      setActionLoading(true);
      try {
        const res = await fetch("/api/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove-provider-key", provider, mode, envKey }),
        });
        const json = await res.json();
        if (json.ok) {
          setToast({ message: `${provider} key removed`, type: "success" });
          requestRestart(`${provider} audio credentials were removed.`);
          await fetchData();
          return true;
        }
        setToast({ message: json.error || "Failed to remove key", type: "error" });
        await fetchData();
        return false;
      } catch (err) {
        setToast({ message: String(err), type: "error" });
        await fetchData();
        return false;
      } finally {
        setActionLoading(false);
      }
    },
    [fetchData]
  );

  const enableTalkMode = useCallback(async () => {
    setTalkEnabling(true);
    try {
      const res = await fetch("/api/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-config", section: "talk", config: {} }),
      });
      const json = await res.json();
      if (json.ok) {
        setToast({
          message: "Talk Mode enabled. Refreshing after gateway restart…",
          type: "success",
        });
        requestRestart("Talk Mode was enabled.");
        // Show as enabled immediately (parsed talk section will exist after patch)
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            config: {
              ...prev.config,
              talk: {
                ...prev.config.talk,
                parsed: {},
              },
            },
          };
        });
        // Refetch after a delay so the restarted gateway is up and we get fresh config
        await new Promise((r) => setTimeout(r, 2500));
        await fetchData();
      } else {
        setToast({ message: json.error || "Failed to enable Talk Mode", type: "error" });
        await fetchData();
      }
    } catch (err) {
      setToast({ message: String(err), type: "error" });
      await fetchData();
    } finally {
      setTalkEnabling(false);
    }
  }, [fetchData]);

  // Auto-mode is now handled by setAutoMode directly

  /* ── Render ────────────── */

  if (loading) {
    return (
      <SectionLayout>
        <ContentLoadingState size="lg" />
      </SectionLayout>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Failed to load audio configuration
      </div>
    );
  }

  const {
    status,
    providers: providersData,
    config: configData,
    prefs,
  } = data;

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Volume2 className="h-5 w-5 text-fg-secondary dark:text-foreground" />
            Audio & Voice
          </span>
        }
        description="Text-to-speech, Talk Mode, and audio understanding configuration"
        actions={
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={apiWarning} degraded={apiDegraded} />
            <button
              onClick={fetchData}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        }
      />

      <SectionBody width="content" padding="regular" innerClassName="space-y-6">
        {/* Top: recap of current config (read-only) */}
        <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Current configuration
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="flex items-center gap-2">
              <Waves className="h-3.5 w-3.5 text-fg-secondary shrink-0" />
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Auto-TTS</p>
                <p className="text-xs font-medium text-foreground">{status.auto === "off" ? "Off" : status.auto}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Speaker className="h-3.5 w-3.5 text-fg-secondary shrink-0" />
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Provider</p>
                <p className="text-xs font-medium text-foreground">{providersData.active || status.provider || "none"}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Mic className="h-3.5 w-3.5 text-success-fg shrink-0" />
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Talk Mode</p>
                <p className="text-xs font-medium text-foreground">
                  {((configData.talk.parsed != null && typeof configData.talk.parsed === "object") || (configData.talk.resolved && Object.keys(configData.talk.resolved).length > 0))
                    ? "Configured"
                    : "Not configured"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-info-fg shrink-0" />
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Providers</p>
                <p className="text-xs font-medium text-foreground">
                  {providersData.providers.filter((p) => p.configured).length} configured
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Radio className="h-4 w-4 text-success-fg" />
                Voice Provider
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Switch the active TTS engine without digging into the provider cards.
              </p>
            </div>
            <span className="rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-success-fg">
              Active: {providersData.active || status.provider || "none"}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {providersData.providers.map((provider) => {
              const canSwitch = provider.configured;
              const active = providersData.active === provider.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => {
                    if (!active && canSwitch) {
                      void setProvider(provider.id);
                    }
                  }}
                  disabled={actionLoading || !canSwitch || active}
                  className={cn(
                    "rounded-xl border px-3 py-3 text-left transition-all",
                    active
                      ? "border-success-border bg-success-bg"
                      : canSwitch
                        ? "border-foreground/10 bg-background hover:border-foreground/20 hover:bg-muted"
                        : "border-foreground/10 bg-foreground/5 opacity-70"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{PROVIDER_ICONS[provider.id] || "🔈"}</span>
                    <span className="text-sm font-medium text-foreground">{provider.name}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    {active ? (
                      <span className="rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-success-fg">
                        Active
                      </span>
                    ) : canSwitch ? (
                      <span className="rounded-full border border-foreground/10 bg-background px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-fg-secondary">
                        Switch
                      </span>
                    ) : (
                      <span className="rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-warning-fg">
                        {provider.authLabel || "Needs key"}
                      </span>
                    )}
                  </div>
                  {provider.authSource && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {provider.authSource}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Below: edit, test, modify */}
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          Settings & testing
        </p>

        {/* Auto-TTS mode selector */}
        <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-5 space-y-4">
              <div>
                <h2 className="text-xs font-semibold text-foreground flex items-center gap-2">
                  <Waves className="h-4 w-4 text-fg-secondary" />
                  Auto-TTS
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  The agent always sends text. This setting controls whether that text is read aloud to you (TTS).
                  {status.auto === "off"
                    ? " Off = you only see text unless you request speech (e.g. Voice Sample Lab below or /tts audio in chat)."
                    : status.auto === "always"
                      ? " All replies are spoken to you."
                      : status.auto === "inbound"
                        ? " Replies are spoken when you sent a voice message."
                        : " Only replies to messages tagged with /tts are spoken."}
                </p>
                <p className="mt-2 text-xs font-medium text-fg-secondary">
                  Click a mode below to switch Auto-TTS behavior.
                </p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {AUTO_MODES.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => setAutoMode(m.value)}
                    disabled={actionLoading}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left transition-all cursor-pointer shadow-sm",
                      status.auto === m.value
                        ? "border-border-strong bg-muted-foreground/12 ring-1 ring-border-strong"
                        : "border-foreground/10 bg-background hover:border-foreground/20 hover:bg-muted"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={cn(
                          "text-xs font-medium",
                          status.auto === m.value ? "text-fg-secondary" : "text-foreground"
                        )}
                      >
                        {m.label}
                      </p>
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                          status.auto === m.value
                            ? "bg-muted-foreground/20 text-fg-secondary"
                            : "bg-foreground/5 text-muted-foreground"
                        )}
                      >
                        {status.auto === m.value ? "Selected" : "Click to use"}
                      </span>
                    </div>
                    <p className="text-xs text-fg-subtle mt-0.5">{m.desc}</p>
                  </button>
                ))}
              </div>
            </div>

        {/* TTS Providers */}
        <div>
          <h2 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-2">
            <Speaker className="h-4 w-4 text-fg-secondary" />
            TTS Providers
          </h2>
          <div className="space-y-2">
            {providersData.providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                isActive={providersData.active === p.id}
                onSelect={() => setProvider(p.id)}
                loading={actionLoading}
                onTest={(pid, voice) =>
                  testTts(
                    `Hello! This is a ${p.name} voice test for the text to speech system.`,
                    pid,
                    voice
                  )
                }
                onSaveKey={saveProviderKey}
                onRemoveKey={removeProviderKey}
              />
            ))}
          </div>
        </div>

        {/* Test TTS */}
        <TtsTestPanel
          onTest={testTts}
          testing={testing}
          providers={providersData.providers}
          activeProvider={providersData.active || status.provider}
        />

        {/* Test result with audio player */}
        {testResult && <AudioPlayer key={testResult.key} result={testResult} />}

        {/* TTS Settings */}
        <TtsSettingsPanel
          status={status}
          prefs={prefs}
          onUpdateConfig={updateConfig}
          loading={actionLoading}
        />

        {/* Talk Mode */}
        <TalkModeSection
          config={configData.talk.resolved || {}}
          talkSectionExists={
            configData.talk.parsed != null && typeof configData.talk.parsed === "object"
          }
          onEnableTalk={enableTalkMode}
          enabling={talkEnabling}
          onTestTalk={testTalkInBrowser}
          testingTalk={testingTalk}
        />

        {/* Slash commands reference (accordion, closed by default) */}
        <div className="rounded-xl border border-foreground/10 bg-foreground/5 overflow-hidden">
          <button
            type="button"
            onClick={() => setSlashCommandsOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 p-4 text-left hover:bg-foreground/5 transition-colors"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Zap className="h-4 w-4 text-warning-fg" />
              Slash Commands
            </div>
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", slashCommandsOpen && "rotate-180")}
            />
          </button>
          {slashCommandsOpen && (
            <div className="border-t border-foreground/10 p-4 pt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Control TTS from any channel using slash commands:
              </p>
              <div className="rounded-lg bg-muted p-3 font-mono text-xs text-muted-foreground space-y-1">
                <p><span className="text-fg-secondary">/tts</span> off &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-fg-subtle"># Disable TTS</span></p>
                <p><span className="text-fg-secondary">/tts</span> always &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-fg-subtle"># Speak all replies</span></p>
                <p><span className="text-fg-secondary">/tts</span> inbound &nbsp;&nbsp;&nbsp;<span className="text-fg-subtle"># Reply to voice with voice</span></p>
                <p><span className="text-fg-secondary">/tts</span> tagged &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-fg-subtle"># Only /tts tagged messages</span></p>
                <p><span className="text-fg-secondary">/tts</span> status &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-fg-subtle"># Show current state</span></p>
                <p><span className="text-fg-secondary">/tts</span> provider openai <span className="text-fg-subtle"># Switch provider</span></p>
                <p><span className="text-fg-secondary">/tts</span> limit 2000 &nbsp;<span className="text-fg-subtle"># Summary threshold</span></p>
                <p><span className="text-fg-secondary">/tts</span> audio Hello! &nbsp;<span className="text-fg-subtle"># One-off TTS</span></p>
              </div>
              <p className="text-xs text-fg-subtle">
                Note: Discord uses <code className="rounded bg-foreground/10 px-1 text-xs">/voice</code> instead
                (because <code className="rounded bg-foreground/10 px-1 text-xs">/tts</code> is a built-in Discord command).
              </p>
            </div>
          )}
        </div>

        {/* Gateway RPC reference (accordion, closed by default) */}
        <div className="rounded-xl border border-foreground/10 bg-foreground/5 overflow-hidden">
          <button
            type="button"
            onClick={() => setGatewayRpcOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 p-4 text-left hover:bg-foreground/5 transition-colors"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Radio className="h-4 w-4 text-info-fg" />
              Gateway RPC Methods
            </div>
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", gatewayRpcOpen && "rotate-180")}
            />
          </button>
          {gatewayRpcOpen && (
            <div className="border-t border-foreground/10 p-4 pt-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {[
                  "tts.status",
                  "tts.enable",
                  "tts.disable",
                  "tts.convert",
                  "tts.setProvider",
                  "tts.providers",
                ].map((m) => (
                  <div
                    key={m}
                    className="rounded-lg border border-foreground/10 bg-muted/50 px-3 py-2 font-mono text-xs text-info-fg"
                  >
                    {m}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SectionBody>

      {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
    </SectionLayout>
  );
}
