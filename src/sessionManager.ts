import { chunkForDiscord } from "./common/chunkForDiscord.js";
import { ProviderStore } from "./common/providerStore.js";
import { createProvider, isValidProviderName } from "./providers/index.js";
import { PROVIDERS, isUnsupported, UnsupportedError, type Provider } from "./providers/types.js";
import type {
  AgentInfo,
  AuthStatus,
  CompactResult,
  HistoryEvent,
  McpServerStatus,
  ModelInfo,
  PlanInfo,
  SendAttachment,
  SessionMode,
  StatusInfo,
} from "./providers/types.js";

export { chunkForDiscord, isUnsupported, UnsupportedError };

/**
 * Returns a friendly Discord-safe message for an UnsupportedError, or null when
 * the error is not one. Handlers use this so unsupported provider features show
 * a clean "__provider__ does not support X" instead of the generic error.
 */
export function unsupportedMessage(err: unknown): string | null {
  if (isUnsupported(err)) return `⚠️ ${err.message}`;
  return null;
}

/**
 * Facade in front of all AI providers (Copilot / Codex / OpenCode).
 *
 * The whole Discord layer (bot, commands, handlers) talks only to this class.
 * It can host any number of providers at once and lets a Discord session key
 * (user ID or thread ID) pick its active provider at runtime (`/provider set`),
 * so you can switch between e.g. Codex and OpenCode without restarting.
 *
 * Providers are created lazily and cached. Each provider keeps its own session
 * history per key (namespaced on disk), so switching back to a provider resumes
 * that provider's own thread for the key.
 *
 * Methods a provider doesn't support throw `UnsupportedError`, which handlers
 * render as a friendly in-Discord message.
 */
export class SessionManager {
  /** Default provider name, from the PROVIDER env var unless overridden. */
  readonly name: string;
  /** Default provider display name. */
  readonly displayName: string;

  private providers: Map<string, Provider> = new Map();
  private overrides: Map<string, string> = new Map(); // session key -> provider name
  private store: ProviderStore;

  constructor(defaultName?: string, store?: ProviderStore) {
    const name = (defaultName ?? process.env.PROVIDER ?? "copilot").trim().toLowerCase() || "copilot";
    if (!isValidProviderName(name)) {
      throw new Error(`Unknown PROVIDER "${name}". Choose one of: ${PROVIDERS.join(", ")}.`);
    }
    this.store = store ?? new ProviderStore();
    this.name = name;
    this.displayName = this.getProvider(name).displayName;
    // Hydrate persisted per-key overrides.
    for (const [key, provider] of Object.entries(this.store.all())) {
      if (isValidProviderName(provider)) this.overrides.set(key, provider);
    }
  }

  // ── Provider selection ──────────────────────────────────────────────────────

  private getProvider(name: string): Provider {
    let provider = this.providers.get(name);
    if (!provider) {
      provider = createProvider(name);
      this.providers.set(name, provider);
    }
    return provider;
  }

  /** Resolve the active provider instance for a session key (or default). */
  private providerFor(key?: string): Provider {
    const name = key ? this.activeProviderName(key) : this.name;
    return this.getProvider(name);
  }

  /** Active provider name for a session key, falling back to the default. */
  activeProviderName(key?: string): string {
    if (key) {
      const override = this.overrides.get(key);
      if (override) return override;
    }
    return this.name;
  }

  /** Active provider display name for a session key. */
  activeProviderDisplayName(key?: string): string {
    return this.getProvider(this.activeProviderName(key)).displayName;
  }

  /** Names of all providers this build can run. */
  listAvailableProviders(): string[] {
    return [...PROVIDERS];
  }

  /**
   * Set the active provider for a session key. The new provider resumes its own
   * prior thread for the key (if any); no session data is discarded. Passing the
   * default provider name clears the override.
   */
  setSessionProvider(key: string, providerName: string): Promise<void> {
    const name = providerName.trim().toLowerCase();
    if (!isValidProviderName(name)) {
      throw new Error(`Unknown provider "${providerName}". Choose: ${PROVIDERS.join(", ")}.`);
    }
    if (name === this.name) {
      this.overrides.delete(key);
      this.store.delete(key);
    } else {
      this.overrides.set(key, name);
      this.store.set(key, name);
    }
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    const all = Array.from(this.providers.values());
    this.providers.clear();
    await Promise.all(all.map((p) => p.shutdown()));
  }

  // ── Chat & session operations (delegated to the active provider for key) ────

  sendMessage(userId: string, prompt: string, imagePaths?: SendAttachment[]): Promise<string> {
    return this.providerFor(userId).sendMessage(userId, prompt, imagePaths);
  }

  getStatus(key?: string): Promise<StatusInfo> {
    return this.providerFor(key).getStatus();
  }

  getHistory(userId: string): Promise<HistoryEvent[] | null> {
    return this.providerFor(userId).getHistory(userId);
  }

  listModels(key?: string): Promise<ModelInfo[]> {
    return this.providerFor(key).listModels();
  }

  setModel(userId: string, model: string): Promise<void> {
    return this.providerFor(userId).setModel(userId, model);
  }

  getCurrentModel(key: string): Promise<string | undefined> {
    return this.providerFor(key).getCurrentModel(key);
  }

  listReasoningEfforts(key?: string): Promise<string[]> {
    return this.providerFor(key).listReasoningEfforts();
  }

  setReasoningEffort(key: string, effort: string): Promise<void> {
    return this.providerFor(key).setReasoningEffort(key, effort);
  }

  getCurrentReasoningEffort(key: string): Promise<string> {
    return this.providerFor(key).getCurrentReasoningEffort(key);
  }

  listAgents(key: string): Promise<AgentInfo[]> {
    return this.providerFor(key).listAgents(key);
  }

  getCurrentAgent(key: string): Promise<AgentInfo | null> {
    return this.providerFor(key).getCurrentAgent(key);
  }

  selectAgent(key: string, name: string): Promise<AgentInfo> {
    return this.providerFor(key).selectAgent(key, name);
  }

  deselectAgent(key: string): Promise<void> {
    return this.providerFor(key).deselectAgent(key);
  }

  getMode(key: string): Promise<SessionMode> {
    return this.providerFor(key).getMode(key);
  }

  setMode(key: string, mode: SessionMode): Promise<void> {
    return this.providerFor(key).setMode(key, mode);
  }

  compact(key: string): Promise<CompactResult> {
    return this.providerFor(key).compact(key);
  }

  startFleet(key: string, prompt?: string): Promise<boolean> {
    return this.providerFor(key).startFleet(key, prompt);
  }

  readPlan(key: string): Promise<PlanInfo> {
    return this.providerFor(key).readPlan(key);
  }

  updatePlan(key: string, content: string): Promise<void> {
    return this.providerFor(key).updatePlan(key, content);
  }

  deletePlan(key: string): Promise<void> {
    return this.providerFor(key).deletePlan(key);
  }

  listWorkspaceFiles(key: string): Promise<string[]> {
    return this.providerFor(key).listWorkspaceFiles(key);
  }

  readWorkspaceFile(key: string, filePath: string): Promise<string> {
    return this.providerFor(key).readWorkspaceFile(key, filePath);
  }

  createWorkspaceFile(key: string, filePath: string, content: string): Promise<void> {
    return this.providerFor(key).createWorkspaceFile(key, filePath, content);
  }

  resetSession(key: string): Promise<void> {
    return this.providerFor(key).resetSession(key);
  }

  setSessionWorkingDir(key: string, dir: string): void {
    return this.providerFor(key).setSessionWorkingDir(key, dir);
  }

  getSessionWorkingDir(key: string): string | undefined {
    return this.providerFor(key).getSessionWorkingDir(key);
  }

  setSessionMcpEnabled(key: string, serverName: string, enabled: boolean): void {
    return this.providerFor(key).setSessionMcpEnabled(key, serverName, enabled);
  }

  getMcpStatus(key: string): McpServerStatus[] {
    return this.providerFor(key).getMcpStatus(key);
  }
}
