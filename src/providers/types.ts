export const PROVIDERS = ["copilot", "codex", "opencode"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export class UnsupportedError extends Error {
  constructor(providerName: string, feature: string) {
    super(`The **${providerName}** provider does not support **${feature}**.`);
    this.name = "UnsupportedError";
  }
}

export function isUnsupported(err: unknown): err is UnsupportedError {
  return err instanceof UnsupportedError;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface AgentInfo {
  name: string;
  displayName: string;
  description: string;
}

export interface AuthStatus {
  isAuthenticated: boolean;
  login?: string;
  authType?: string;
  host?: string;
  statusMessage?: string;
}

export interface StatusInfo {
  status: { version?: string };
  authStatus: AuthStatus;
}

export interface HistoryEvent {
  type: "user.message" | "assistant.message";
  data: { content: string };
}

export interface CompactResult {
  success: boolean;
  tokensRemoved: number;
  messagesRemoved: number;
}

export interface PlanInfo {
  exists: boolean;
  content: string | null;
  path: string | null;
}

export type SessionMode = "interactive" | "plan" | "autopilot";

export interface McpServerStatus {
  name: string;
  source: string;
  enabled: boolean;
  skipped: boolean;
}

export interface SendAttachment {
  path: string;
  displayName?: string;
}

/**
 * Provider-agnostic session manager contract. Every slash command handler and
 * the Discord bot talk only to this interface, so a provider can be swapped
 * (Copilot, Codex, OpenCode, …) purely via configuration.
 *
 * Methods a provider cannot implement should throw `UnsupportedError`, which
 * handlers render as a friendly in-Discord message instead of a crash.
 */
export interface Provider {
  /** Stable identifier, e.g. "copilot", "codex", "opencode". */
  readonly name: ProviderName | string;
  /** Human-facing name for /status etc., e.g. "GitHub Copilot". */
  readonly displayName: string;

  sendMessage(userId: string, prompt: string, imagePaths?: SendAttachment[]): Promise<string>;
  getStatus(): Promise<StatusInfo>;
  getHistory(userId: string): Promise<HistoryEvent[] | null>;
  listModels(): Promise<ModelInfo[]>;
  setModel(userId: string, model: string): Promise<void>;
  getCurrentModel(key: string): Promise<string | undefined>;

  listReasoningEfforts(): Promise<string[]>;
  setReasoningEffort(key: string, effort: string): Promise<void>;
  getCurrentReasoningEffort(key: string): Promise<string>;

  listAgents(key: string): Promise<AgentInfo[]>;
  getCurrentAgent(key: string): Promise<AgentInfo | null>;
  selectAgent(key: string, name: string): Promise<AgentInfo>;
  deselectAgent(key: string): Promise<void>;

  getMode(key: string): Promise<SessionMode>;
  setMode(key: string, mode: SessionMode): Promise<void>;
  compact(key: string): Promise<CompactResult>;
  startFleet(key: string, prompt?: string): Promise<boolean>;
  readPlan(key: string): Promise<PlanInfo>;
  updatePlan(key: string, content: string): Promise<void>;
  deletePlan(key: string): Promise<void>;

  listWorkspaceFiles(key: string): Promise<string[]>;
  readWorkspaceFile(key: string, filePath: string): Promise<string>;
  createWorkspaceFile(key: string, filePath: string, content: string): Promise<void>;

  resetSession(key: string): Promise<void>;
  setSessionWorkingDir(key: string, dir: string): void;
  getSessionWorkingDir(key: string): string | undefined;
  setSessionMcpEnabled(key: string, serverName: string, enabled: boolean): void;
  getMcpStatus(key: string): McpServerStatus[];

  shutdown(): Promise<void>;
}

/** Canonical list of reasoning-effort levels shared across providers that support it. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";
