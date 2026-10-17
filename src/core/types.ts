export type ProviderId = "codex" | "claude";

/**
 * What the user asked for, stored instead of a concrete model id so the
 * choice survives provider model upgrades. Resolved at session start.
 */
export interface ModelIntent {
  provider: ProviderId;
  /** e.g. "sol" for codex, "opus" for claude */
  family: string;
  effort: string;
}

export interface ResolvedModel {
  provider: ProviderId;
  /** concrete id passed to the CLI (or an alias the CLI resolves itself) */
  model: string;
  effort: string;
  /** set when the intent could not be met exactly */
  note?: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault: boolean;
  supportsImages: boolean;
}

export type UserInput =
  | { type: "text"; text: string }
  | { type: "image"; path: string }
  | { type: "file"; path: string };

export type AgentEvent =
  | { kind: "session"; sessionId: string; model: string }
  | { kind: "text-delta"; text: string }
  | { kind: "tool"; name: string; detail: string; summary?: string; status: "started" | "completed" }
  /** the account's rate-limit usage, as reported alongside a model response */
  | { kind: "account-usage"; usage: AccountUsage }
  | { kind: "turn-complete"; text: string; status: "completed" | "interrupted" | "failed"; error?: string };

export type ApprovalRequest = {
  provider: ProviderId;
  kind: "command" | "file-change" | "other";
  detail: string;
  /** aborted when the provider resolves or drops the request on its own */
  signal?: AbortSignal;
};
export type ApprovalHandler = (req: ApprovalRequest) => Promise<boolean>;

/** stdio MCP server to attach to a session (used for delegation) */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SessionOptions {
  cwd: string;
  resolved: ResolvedModel;
  resumeId?: string;
  mcpServers?: McpServerSpec[];
  /** extra instructions appended to the provider's own system prompt */
  instructions?: string;
  /** "ask" routes risky actions to onApproval; "auto" lets the provider decide */
  approvals?: "ask" | "auto";
  /** allow network access from sandboxed commands (codex sandboxes block it by default) */
  network?: boolean;
  onApproval?: ApprovalHandler;
}

export interface AgentSession {
  readonly provider: ProviderId;
  /** provider-native session/thread id; may change after the first turn (claude resume forks) */
  readonly sessionId: string;
  send(input: UserInput[]): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** How much of a subscription's rate limits is used, in percent (0–100), across everything on that account. */
export interface AccountUsage {
  fiveHour: number | null;
  weekly: number | null;
  /** ms epoch of the reading */
  at: number;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** current account usage; may cost a tiny request on providers without a free usage endpoint */
  readUsage(): Promise<AccountUsage | null>;
  /** false once a shared backend process has died; the core then recreates the adapter */
  alive(): boolean;
  listModels(): Promise<ModelInfo[]>;
  startSession(opts: SessionOptions): Promise<AgentSession>;
  dispose(): Promise<void>;
}
