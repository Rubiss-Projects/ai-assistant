import os from "os";
import path from "path";
import { BuiltInTools, CopilotClient, CopilotSession, MCPServerConfig, ToolSet, approveAll } from "@github/copilot-sdk";
import type { CopilotClientOptions, PermissionHandler, SessionConfigBase, SessionEvent } from "@github/copilot-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import { providerSystemPrompt } from "../common/systemPrompt.js";
import { captureAgentArtifacts, withArtifactOutputPrompt } from "../common/agentResponse.js";
import { configuredMilliseconds, startProgressUpdates } from "../common/runLifecycle.js";
import {
  configuredSecurityMode,
  ensureProviderWorkingDirectory,
  providerChildEnvironment,
  resolveConfiguredWorkspace,
  secureSystemPrompt,
  workspacePathIsAllowed,
} from "../common/providerSecurity.js";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  UnsupportedError,
  type AgentInfo,
  type AgentResponse,
  type AuthStatus,
  type CompactResult,
  type HistoryEvent,
  type McpServerStatus,
  type ModelInfo,
  type PlanInfo,
  type Provider,
  type ReasoningEffort,
  RunTimeoutError,
  type SendAttachment,
  type SendMessageOptions,
  type SessionMode,
  type StatusInfo,
} from "./types.js";

const DEFAULT_MODEL = process.env.COPILOT_MODEL?.trim() || "claude-haiku-4.5";

const COPILOT_LOCAL_TOOLS = [
  "view",
  "create",
  "create_file",
  "edit",
  "apply_patch",
  "str_replace_editor",
  "grep",
  "glob",
  "report_intent",
  "web_search",
  "web_fetch",
] as const;

export function createCopilotPermissionHandler(workingDirectory: string): PermissionHandler {
  return (request) => {
    const reject = (feedback: string) => ({ kind: "reject" as const, feedback });
    if (
      request.managedApprovalRequired ||
      ("requestSandboxBypass" in request && request.requestSandboxBypass === true)
    ) {
      return reject("Interactive approval and sandbox bypass are unavailable in Discord sessions.");
    }

    switch (request.kind) {
      case "read":
        return workspacePathIsAllowed(workingDirectory, request.path)
          ? { kind: "approve-once" }
          : reject("Reads are limited to non-sensitive files in the assigned workspace.");
      case "write":
        return workspacePathIsAllowed(workingDirectory, request.fileName)
          ? { kind: "approve-once" }
          : reject("Writes are limited to non-sensitive files in the assigned workspace.");
      case "mcp":
        return request.readOnly
          ? { kind: "approve-once" }
          : reject("Mutating connector and MCP tools are disabled for Discord sessions.");
      case "url":
        return { kind: "approve-once" };
      case "shell":
        return reject("Arbitrary shell execution is disabled for this shared provider.");
      default:
        return reject("This capability is not enabled for Discord sessions.");
    }
  };
}

function copilotAvailableTools(): ToolSet {
  return new ToolSet()
    .addBuiltIn(BuiltInTools.Isolated)
    .addBuiltIn(COPILOT_LOCAL_TOOLS)
    .addMcp("*");
}

export function copilotClientOptions(
  source: Record<string, string | undefined> = process.env,
): CopilotClientOptions | undefined {
  const gitHubToken = source.COPILOT_GITHUB_TOKEN?.trim() || source.GH_TOKEN?.trim();
  if (configuredSecurityMode(source) === "unrestricted") {
    return gitHubToken ? { gitHubToken } : undefined;
  }

  const environment = providerChildEnvironment("copilot", source);
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  return {
    mode: "empty",
    env: environment,
    baseDirectory: source.COPILOT_HOME?.trim() || path.join(home, ".copilot"),
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : { useLoggedInUser: true }),
  };
}

export function copilotWorkspaceMcpEnabled(
  source: Record<string, string | undefined> = process.env,
): boolean {
  return configuredSecurityMode(source) === "unrestricted";
}

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

async function sendUntilIdle(
  session: CopilotSession,
  message: { prompt: string; attachments?: Array<{ type: "file"; path: string; displayName?: string }> },
  options?: SendMessageOptions,
): Promise<string> {
  const hardTimeoutMs = configuredMilliseconds("COPILOT_TIMEOUT_MS", 60 * 60 * 1000);
  const cancellationGraceMs = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5_000);
  let lastAssistantMessage: string | undefined;
  let settled = false;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const stopProgress = startProgressUpdates(options);

  return new Promise<string>((resolve, reject) => {
    let unsubscribe = (): void => {};
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      stopProgress();
      clearTimeout(hardTimer);
      unsubscribe();
      operation();
    };
    unsubscribe = session.on((event) => {
      if (event.type === "assistant.message") {
        lastAssistantMessage = event.data.content;
      } else if (event.type === "session.idle") {
        finish(() => resolve(lastAssistantMessage ?? "(no response)"));
      } else if (event.type === "session.error") {
        finish(() => reject(new Error(event.data.message)));
      }
    });

    hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopProgress();
      unsubscribe();

      const abortAcknowledged = Promise.resolve().then(() => session.abort()).then(() => true, (error) => {
        console.warn("[CopilotProvider] Failed to abort timed-out session:", error);
        return false;
      });
      let abortDeadlineTimer: ReturnType<typeof setTimeout>;
      const abortDeadline = new Promise<boolean>((resolveAbort) => {
        abortDeadlineTimer = setTimeout(() => resolveAbort(false), cancellationGraceMs);
      });
      Promise.race([abortAcknowledged, abortDeadline]).then((cancelled) => {
        clearTimeout(abortDeadlineTimer);
        reject(new RunTimeoutError("GitHub Copilot", hardTimeoutMs, cancelled));
      });
    }, hardTimeoutMs);

    session.send(message).catch((error) => finish(() => reject(error)));
  });
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
  // Directory actually bound into each live SDK session.
  private sessionWorkingDirectories: Map<string, string> = new Map();
  // Per-session MCP tool overrides: server name → tools array (["*"] = enabled, [] = disabled)
  private mcpToolOverrides: Map<string, Record<string, string[]>> = new Map();
  // Per-session reasoning-effort override (host tracks the effective value)
  private reasoningEffortOverrides: Map<string, ReasoningEffort> = new Map();

  constructor() {
    this.client = new CopilotClient(copilotClientOptions());
  }

  private async getOrCreateSession(key: string): Promise<CopilotSession> {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const shared = configuredSecurityMode() === "shared";
    const workingDir = shared
      ? this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory()
      : this.workingDirOverrides.get(key);
    // Workspace MCP configuration may contain stdio commands. Loading it in shared mode
    // would execute repository-controlled code before the permission handler can intervene.
    const mcpServers = copilotWorkspaceMcpEnabled() ? this.buildMcpConfig(key) : {};
    const configuredPrompt = providerSystemPrompt();
    const sessionConfig: SessionConfigBase = shared
      ? {
          onPermissionRequest: createCopilotPermissionHandler(workingDir!),
          availableTools: copilotAvailableTools(),
          enableSessionStore: true,
          workingDirectory: workingDir!,
          ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
          systemMessage: { mode: "append", content: secureSystemPrompt(configuredPrompt) },
        }
      : {
          onPermissionRequest: approveAll,
          skillDirectories: [path.join(os.homedir(), ".agents", "skills")],
          ...(workingDir ? { workingDirectory: workingDir } : {}),
          ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
          systemMessage: { mode: "append", content: configuredPrompt },
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
        this.sessionWorkingDirectories.set(key, workingDir ?? ensureProviderWorkingDirectory());
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
      this.sessionWorkingDirectories.delete(key);
    }
    await session.disconnect().catch((err) =>
      console.warn(`[CopilotProvider] Failed to disconnect stale session ${session.sessionId}:`, err)
    );
  }

  private abandonTimedOutSession(key: string, session: CopilotSession): void {
    if (this.sessions.get(key) === session) {
      this.sessions.delete(key);
      this.sessionWorkingDirectories.delete(key);
    }
    this.store.delete(key);
    session.disconnect().catch((err) =>
      console.warn(`[CopilotProvider] Failed to disconnect timed-out session ${session.sessionId}:`, err)
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
    imagePaths?: SendAttachment[],
    options?: SendMessageOptions,
  ): Promise<AgentResponse> {
    const tail = this.messageQueues.get(userId) ?? Promise.resolve();
    const next = tail.then(async () => {
      const attachments = imagePaths?.map((a) => ({
        type: "file" as const,
        path: a.path,
        ...(a.displayName ? { displayName: a.displayName } : {}),
      }));
      return this.withLiveSession(userId, async (session) => {
        try {
          const workingDirectory = this.sessionWorkingDirectories.get(userId)
            ?? this.workingDirOverrides.get(userId)
            ?? ensureProviderWorkingDirectory();
          return await captureAgentArtifacts(workingDirectory, (artifactRun) =>
            sendUntilIdle(
              session,
              {
                prompt: withArtifactOutputPrompt(prompt, artifactRun),
                ...(attachments?.length ? { attachments } : {}),
              },
              options,
            )
          );
        } catch (error) {
          if (error instanceof RunTimeoutError && !error.cancellationConfirmed) {
            this.abandonTimedOutSession(userId, session);
          }
          throw error;
        }
      });
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
    this.sessionWorkingDirectories.delete(key);
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
    const canonical = resolveConfiguredWorkspace(dir);
    const current = this.workingDirOverrides.get(key) ?? this.sessionWorkingDirectories.get(key);
    const comparable = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
    if (current && comparable(current) === comparable(canonical)) {
      this.workingDirOverrides.set(key, canonical);
      return;
    }
    this.workingDirOverrides.set(key, canonical);
    // Queue the transition behind any active creation/send. A later operation
    // will queue behind this one and cannot observe a half-evicted session.
    void this.enqueueSessionOperation(key, async () => {
      const existing = this.sessions.get(key);
      this.sessions.delete(key);
      this.sessionWorkingDirectories.delete(key);
      this.store.delete(key);
      if (existing) await existing.disconnect().catch((error) => {
        console.warn(`[CopilotProvider] Could not disconnect session after workspace change for ${key}:`, error);
      });
    });
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
    this.sessionWorkingDirectories.clear();
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
