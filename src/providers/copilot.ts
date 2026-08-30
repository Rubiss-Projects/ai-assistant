import fs from "fs";
import os from "os";
import path from "path";
import { CopilotClient, CopilotSession, MCPServerConfig, approveAll } from "@github/copilot-sdk";
import type { SessionEvent } from "@github/copilot-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  UnsupportedError,
  type AgentInfo,
  type AuthStatus,
  type CompactResult,
  type HistoryEvent,
  type McpServerStatus,
  type ModelInfo,
  type PlanInfo,
  type Provider,
  type ReasoningEffort,
  type SendAttachment,
  type SessionMode,
  type StatusInfo,
} from "./types.js";

const DEFAULT_MODEL = process.env.COPILOT_MODEL?.trim() || "claude-haiku-4.5";

function isSessionNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Session not found:/i.test(message);
}

function toHistoryEvent(event: SessionEvent): HistoryEvent | null {
  switch (event.type) {
    case "user.message":
      return { type: event.type, data: { content: event.data.content } };
    case "assistant.message":
      return {
        type: event.type,
        data: {
          content: event.data.content,
          ...(event.data.parentToolCallId
            ? { parentToolCallId: event.data.parentToolCallId }
            : {}),
        },
      };
    default:
      return null;
  }
}

/**
 * Session manager backed by the GitHub Copilot SDK. Each Provider method maps
 * to a Copilot session RPC; features Copilot does not expose throw
 * `UnsupportedError`.
 */
export class CopilotProvider implements Provider {
  readonly name = "copilot" as const;
  readonly displayName = "GitHub Copilot";

  private client: CopilotClient;
  // Stores settled sessions for established users
  private sessions: Map<string, CopilotSession> = new Map();
  // Stores in-flight creation promises to prevent duplicate session creation (TOCTOU fix)
  private pending: Map<string, Promise<CopilotSession>> = new Map();
  // Serializes session-touching operations per key so stale-session recovery can't race itself
  private sessionOperationQueues: Map<string, Promise<unknown>> = new Map();
  // Serializes concurrent sendMessage calls per session to prevent state corruption
  private messageQueues: Map<string, Promise<unknown>> = new Map();
  // Persists Discord key → Copilot session ID across restarts
  private store: SessionStore = new SessionStore(this.name);
  // Per-session working directory override (affects MCP loading and agent file ops)
  private workingDirOverrides: Map<string, string> = new Map();
  // Per-session MCP tool overrides: server name → tools array (["*"] = enabled, [] = disabled)
  private mcpToolOverrides: Map<string, Record<string, string[]>> = new Map();
  // Per-session reasoning-effort override (host tracks the effective value)
  private reasoningEffortOverrides: Map<string, ReasoningEffort> = new Map();

  constructor() {
    const gitHubToken =
      process.env.COPILOT_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
    this.client = new CopilotClient(gitHubToken ? { gitHubToken } : undefined);
  }

  private async getOrCreateSession(key: string): Promise<CopilotSession> {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const userSkillsDir = path.join(os.homedir(), ".agents", "skills");
    const workingDir = this.workingDirOverrides.get(key);
    const mcpServers = this.buildMcpConfig(key);
    const sessionConfig = {
      onPermissionRequest: approveAll,
      skillDirectories: [userSkillsDir] as string[],
      ...(workingDir ? { workingDirectory: workingDir } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };

    const storedSessionId = this.store.get(key);

    const creation = (
      storedSessionId
        ? this.client
            .resumeSession(storedSessionId, sessionConfig)
            .catch((err) => {
              console.warn(
                `[CopilotProvider] Resume failed for ${key} (${storedSessionId}), creating new session:`,
                err
              );
              return this.client.createSession({ model: DEFAULT_MODEL, ...sessionConfig });
            })
        : this.client.createSession({ model: DEFAULT_MODEL, ...sessionConfig })
    )
      .then((session) => {
        if (this.pending.get(key) !== creation) {
          session.disconnect().catch(() => {});
          return session;
        }
        this.sessions.set(key, session);
        this.pending.delete(key);
        this.store.set(key, session.sessionId);
        return session;
      })
      .catch((err) => {
        if (this.pending.get(key) === creation) {
          this.pending.delete(key);
        }
        throw err;
      });

    this.pending.set(key, creation);
    return creation;
  }

  private async evictCachedSession(key: string, session: CopilotSession): Promise<void> {
    if (this.sessions.get(key) === session) {
      this.sessions.delete(key);
    }
    await session.disconnect().catch((err) =>
      console.warn(`[CopilotProvider] Failed to disconnect stale session ${session.sessionId}:`, err)
    );
  }

  private async withLiveSession<T>(
    key: string,
    operation: (session: CopilotSession) => Promise<T>
  ): Promise<T> {
    return this.enqueueSessionOperation(key, async () => {
      const session = await this.getOrCreateSession(key);
      return this.runWithSessionRecovery(key, session, operation);
    });
  }

  private async withExistingLiveSession<T>(
    key: string,
    operation: (session: CopilotSession) => Promise<T>
  ): Promise<T | null> {
    return this.enqueueSessionOperation(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return null;
      return this.runWithSessionRecovery(key, session, operation);
    });
  }

  private enqueueSessionOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.sessionOperationQueues.get(key) ?? Promise.resolve();
    const next = tail.catch(() => {}).then(operation);
    const queueTail = next.catch(() => {});
    this.sessionOperationQueues.set(key, queueTail);
    queueTail.finally(() => {
      if (this.sessionOperationQueues.get(key) === queueTail) {
        this.sessionOperationQueues.delete(key);
      }
    });
    return next;
  }

  private async runWithSessionRecovery<T>(
    key: string,
    session: CopilotSession,
    operation: (session: CopilotSession) => Promise<T>
  ): Promise<T> {
    try {
      return await operation(session);
    } catch (err) {
      if (!isSessionNotFoundError(err)) throw err;

      console.warn(
        `[CopilotProvider] Cached session ${session.sessionId} for ${key} was not found by Copilot; evicting stale session and reinitializing.`
      );
      await this.evictCachedSession(key, session);
      const resumed = await this.getOrCreateSession(key);
      return operation(resumed);
    }
  }

  async sendMessage(
    userId: string,
    prompt: string,
    imagePaths?: SendAttachment[]
  ): Promise<string> {
    const tail = this.messageQueues.get(userId) ?? Promise.resolve();
    const next = tail.then(async () => {
      const attachments = imagePaths?.map((a) => ({
        type: "file" as const,
        path: a.path,
        ...(a.displayName ? { displayName: a.displayName } : {}),
      }));
      const result = await this.withLiveSession(userId, (session) =>
        session.sendAndWait(
          { prompt, ...(attachments?.length ? { attachments } : {}) },
          parseInt(process.env.COPILOT_TIMEOUT_MS ?? "") || 10 * 60 * 1000 // default 10-minute timeout
        )
      );
      return result?.data?.content ?? "(no response)";
    });
    this.messageQueues.set(userId, next.catch(() => {}));
    return next;
  }

  async getStatus(): Promise<StatusInfo> {
    await this.client.start();
    const [status, authStatus] = await Promise.all([
      this.client.getStatus(),
      this.client.getAuthStatus(),
    ]);
    return { status, authStatus: authStatus as AuthStatus };
  }

  async getHistory(userId: string): Promise<HistoryEvent[] | null> {
    const events = await this.withExistingLiveSession(userId, (session) => session.getEvents());
    return events?.map(toHistoryEvent).filter((event) => event !== null) ?? null;
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.client.start();
    return this.client.listModels();
  }

  async setModel(userId: string, model: string): Promise<void> {
    await this.withLiveSession(userId, (session) => session.setModel(model));
  }

  async getCurrentModel(key: string): Promise<string | undefined> {
    const result = await this.withLiveSession(key, (session) => session.rpc.model.getCurrent());
    return result.modelId;
  }

  async listReasoningEfforts(): Promise<string[]> {
    return [...REASONING_EFFORTS];
  }

  async setReasoningEffort(key: string, effort: string): Promise<void> {
    const level = effort as ReasoningEffort;
    if (!REASONING_EFFORTS.includes(level)) {
      throw new Error(`Invalid reasoning effort: ${effort}.`);
    }
    await this.withLiveSession(key, (session) =>
      session.rpc.model.setReasoningEffort({ reasoningEffort: effort })
    );
    this.reasoningEffortOverrides.set(key, level);
  }

  async getCurrentReasoningEffort(key: string): Promise<string> {
    return this.reasoningEffortOverrides.get(key) ?? DEFAULT_REASONING_EFFORT;
  }

  // ── Agent management ────────────────────────────────────────────────────────

  async listAgents(key: string): Promise<AgentInfo[]> {
    const result = await this.withLiveSession(key, (session) => session.rpc.agent.list());
    return result.agents as AgentInfo[];
  }

  async getCurrentAgent(key: string): Promise<AgentInfo | null> {
    const result = await this.withLiveSession(key, (session) => session.rpc.agent.getCurrent());
    return (result.agent as AgentInfo | null) ?? null;
  }

  async selectAgent(key: string, name: string): Promise<AgentInfo> {
    const result = await this.withLiveSession(key, (session) => session.rpc.agent.select({ name }));
    return result.agent as AgentInfo;
  }

  async deselectAgent(key: string): Promise<void> {
    await this.withLiveSession(key, (session) => session.rpc.agent.deselect());
  }

  // ── Session mode ─────────────────────────────────────────────────────────────

  async getMode(key: string): Promise<SessionMode> {
    return this.withLiveSession(key, (session) => session.rpc.mode.get());
  }

  async setMode(key: string, mode: SessionMode): Promise<void> {
    await this.withLiveSession(key, (session) => session.rpc.mode.set({ mode }));
  }

  // ── Compaction ───────────────────────────────────────────────────────────────

  async compact(key: string): Promise<CompactResult> {
    return this.withLiveSession(key, (session) => session.rpc.history.compact());
  }

  // ── Fleet ────────────────────────────────────────────────────────────────────

  async startFleet(key: string, prompt?: string): Promise<boolean> {
    const result = await this.withLiveSession(key, (session) => session.rpc.fleet.start({ prompt }));
    return result.started;
  }

  // ── Plan management ──────────────────────────────────────────────────────────

  async readPlan(key: string): Promise<PlanInfo> {
    const result = await this.withLiveSession(key, (session) => session.rpc.plan.read());
    return {
      exists: result.exists,
      content: result.content as string | null,
      path: result.path as string | null,
    };
  }

  async updatePlan(key: string, content: string): Promise<void> {
    await this.withLiveSession(key, (session) => session.rpc.plan.update({ content }));
  }

  async deletePlan(key: string): Promise<void> {
    await this.withLiveSession(key, (session) => session.rpc.plan.delete());
  }

  // ── Workspace management ─────────────────────────────────────────────────────

  async listWorkspaceFiles(key: string): Promise<string[]> {
    const result = await this.withLiveSession(key, (session) => session.rpc.workspaces.listFiles());
    return result.files;
  }

  async readWorkspaceFile(key: string, filePath: string): Promise<string> {
    const result = await this.withLiveSession(key, (session) =>
      session.rpc.workspaces.readFile({ path: filePath })
    );
    return result.content as string;
  }

  async createWorkspaceFile(key: string, filePath: string, content: string): Promise<void> {
    await this.withLiveSession(key, (session) =>
      session.rpc.workspaces.createFile({ path: filePath, content })
    );
  }

  async resetSession(key: string): Promise<void> {
    const session = this.sessions.get(key);
    const storedSessionId = this.store.get(key);

    this.sessions.delete(key);
    this.pending.delete(key);
    this.sessionOperationQueues.delete(key);
    this.messageQueues.delete(key);
    this.store.delete(key);
    // Preserve working dir and MCP overrides across reset so users don't have
    // to re-configure after /reset.

    if (session) {
      await session.disconnect().catch((err) =>
        console.error(`[CopilotProvider] Error disconnecting session for ${key}:`, err)
      );
    }

    const sessionId = session?.sessionId ?? storedSessionId;
    if (sessionId) {
      await this.client.start();
      await this.client.deleteSession(sessionId).catch((err) =>
        console.error(`[CopilotProvider] Error deleting session ${sessionId}:`, err)
      );
    }
  }

  // --- MCP + Working Directory management ---

  private buildMcpConfig(key: string): Record<string, MCPServerConfig> {
    const workingDir = this.workingDirOverrides.get(key);
    const base = McpConfigLoader.load(workingDir);
    const overrides = this.mcpToolOverrides.get(key) ?? {};
    const result: Record<string, MCPServerConfig> = {};
    for (const [name, cfg] of Object.entries(base)) {
      if (name in overrides) {
        result[name] = { ...cfg, tools: overrides[name] } as unknown as MCPServerConfig;
      } else {
        result[name] = cfg as unknown as MCPServerConfig;
      }
    }
    return result;
  }

  setSessionWorkingDir(key: string, dir: string): void {
    if (!dir || dir.includes("\0")) {
      throw new Error("Invalid workspace path.");
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(path.resolve(dir));
    } catch {
      throw new Error(`Workspace path does not exist: ${path.resolve(dir)}`);
    }
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${canonical}`);
    }
    this.workingDirOverrides.set(key, canonical);
  }

  getSessionWorkingDir(key: string): string | undefined {
    return this.workingDirOverrides.get(key);
  }

  setSessionMcpEnabled(key: string, serverName: string, enabled: boolean): void {
    const overrides = this.mcpToolOverrides.get(key) ?? {};
    overrides[serverName] = enabled ? ["*"] : [];
    this.mcpToolOverrides.set(key, overrides);
  }

  getMcpStatus(key: string): McpServerStatus[] {
    const workingDir = this.workingDirOverrides.get(key);
    const overrides = this.mcpToolOverrides.get(key) ?? {};
    const statusList = McpConfigLoader.status(workingDir);
    return statusList.map((s) => {
      const skipped = !s.enabled; // unresolvable ${input:...} values
      if (skipped) {
        return { ...s, enabled: false, skipped: true };
      }
      if (s.name in overrides) {
        return { ...s, enabled: overrides[s.name].length > 0, skipped: false };
      }
      return { ...s, skipped: false };
    });
  }

  async shutdown(): Promise<void> {
    const allSessions = Array.from(this.sessions.values());
    this.sessions.clear();
    this.pending.clear();
    this.sessionOperationQueues.clear();
    await Promise.all(
      allSessions.map((s) =>
        s.disconnect().catch((err) => console.error("[CopilotProvider] Shutdown error:", err))
      )
    );
    await this.client.stop();
  }
}
