/** Shared shapes for the chat surface. */

export type ChatAgent = {
  id: string;
  name: string;
  emoji: string;
  model: string;
  isDefault: boolean;
};

export type ChatSessionRow = {
  key: string;
  sessionId: string | null;
  agentId: string | null;
  title: string;
  titleSource: "label" | "derived" | "fallback";
  preview: string | null;
  updatedAt: number;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  hasActiveRun: boolean;
  model: string | null;
  totalTokens: number;
};

export type SlashCommandArg = {
  name: string;
  description?: string;
  type?: string;
  choices?: string[];
};

export type SlashCommand = {
  name: string;
  trigger: string;
  aliases: string[];
  description: string;
  category: string;
  source: string;
  acceptsArgs: boolean;
  args: SlashCommandArg[];
};

export type WorkspaceFile = {
  path: string;
  name: string;
  dir: string;
  size: number;
  mtime: number;
};

/** A `@` reference sitting in the composer, shown as a removable chip. */
export type Mention =
  | { kind: "file"; token: string; path: string; name: string }
  | { kind: "agent"; token: string; id: string; name: string };

/**
 * Why a panel is empty. These are deliberately distinct: "the gateway is
 * unreachable" and "you have no conversations yet" look identical in a naive
 * UI and mean opposite things to the user.
 */
export type LoadFailure =
  | { kind: "none" }
  | { kind: "offline"; detail?: string }
  | { kind: "pairing"; detail?: string }
  | { kind: "error"; detail: string };

export const MESSAGE_HISTORY_LIMIT = 100;
