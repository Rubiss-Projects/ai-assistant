import os from "os";
import path from "path";
import { BuiltInTools, CopilotClient, ToolSet, approveAll } from "@github/copilot-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import { configuredSystemPrompt } from "../common/systemPrompt.js";
import { configuredMilliseconds, startProgressUpdates } from "../common/runLifecycle.js";
import { configuredSecurityMode, ensureProviderWorkingDirectory, providerChildEnvironment, resolveConfiguredWorkspace, secureSystemPrompt, workspacePathIsAllowed, } from "../common/providerSecurity.js";
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, RunTimeoutError, } from "./types.js";
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
];
export function createCopilotPermissionHandler(workingDirectory) {
    return (request) => {
        const reject = (feedback) => ({ kind: "reject", feedback });
        if (request.managedApprovalRequired ||
            ("requestSandboxBypass" in request && request.requestSandboxBypass === true)) {
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
function copilotAvailableTools() {
    return new ToolSet()
        .addBuiltIn(BuiltInTools.Isolated)
        .addBuiltIn(COPILOT_LOCAL_TOOLS)
        .addMcp("*");
}
export function copilotClientOptions(source = process.env) {
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
function isSessionNotFoundError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /Session not found:/i.test(message);
}
function toHistoryEvent(event) {
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
async function sendUntilIdle(session, message, options) {
    const hardTimeoutMs = configuredMilliseconds("COPILOT_TIMEOUT_MS", 60 * 60 * 1000);
    const cancellationGraceMs = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5_000);
    let lastAssistantMessage;
    let settled = false;
    let hardTimer;
    const stopProgress = startProgressUpdates(options);
    return new Promise((resolve, reject) => {
        let unsubscribe = () => { };
        const finish = (operation) => {
            if (settled)
                return;
            settled = true;
            stopProgress();
            clearTimeout(hardTimer);
            unsubscribe();
            operation();
        };
        unsubscribe = session.on((event) => {
            if (event.type === "assistant.message") {
                lastAssistantMessage = event.data.content;
            }
            else if (event.type === "session.idle") {
                finish(() => resolve(lastAssistantMessage ?? "(no response)"));
            }
            else if (event.type === "session.error") {
                finish(() => reject(new Error(event.data.message)));
            }
        });
        hardTimer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            stopProgress();
            unsubscribe();
            const abortAcknowledged = Promise.resolve().then(() => session.abort()).then(() => true, (error) => {
                console.warn("[CopilotProvider] Failed to abort timed-out session:", error);
                return false;
            });
            let abortDeadlineTimer;
            const abortDeadline = new Promise((resolveAbort) => {
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
export class CopilotProvider {
    name = "copilot";
    displayName = "GitHub Copilot";
    client;
    // Stores settled sessions for established users
    sessions = new Map();
    // Stores in-flight creation promises to prevent duplicate session creation (TOCTOU fix)
    pending = new Map();
    // Serializes session-touching operations per key so stale-session recovery can't race itself
    sessionOperationQueues = new Map();
    // Serializes concurrent sendMessage calls per session to prevent state corruption
    messageQueues = new Map();
    // Persists Discord key → Copilot session ID across restarts
    store = new SessionStore(this.name);
    // Per-session working directory override (affects MCP loading and agent file ops)
    workingDirOverrides = new Map();
    // Per-session MCP tool overrides: server name → tools array (["*"] = enabled, [] = disabled)
    mcpToolOverrides = new Map();
    // Per-session reasoning-effort override (host tracks the effective value)
    reasoningEffortOverrides = new Map();
    constructor() {
        this.client = new CopilotClient(copilotClientOptions());
    }
    async getOrCreateSession(key) {
        const existing = this.sessions.get(key);
        if (existing)
            return existing;
        const inFlight = this.pending.get(key);
        if (inFlight)
            return inFlight;
        const shared = configuredSecurityMode() === "shared";
        const workingDir = shared
            ? this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory()
            : this.workingDirOverrides.get(key);
        const mcpServers = this.buildMcpConfig(key);
        const configuredPrompt = configuredSystemPrompt();
        const sessionConfig = shared
            ? {
                onPermissionRequest: createCopilotPermissionHandler(workingDir),
                availableTools: copilotAvailableTools(),
                enableSessionStore: true,
                workingDirectory: workingDir,
                ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
                systemMessage: { mode: "append", content: secureSystemPrompt(configuredPrompt) },
            }
            : {
                onPermissionRequest: approveAll,
                skillDirectories: [path.join(os.homedir(), ".agents", "skills")],
                ...(workingDir ? { workingDirectory: workingDir } : {}),
                ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
                ...(configuredPrompt
                    ? { systemMessage: { mode: "append", content: configuredPrompt } }
                    : {}),
            };
        const storedSessionId = this.store.get(key);
        const creation = (storedSessionId
            ? this.client
                .resumeSession(storedSessionId, sessionConfig)
                .catch((err) => {
                console.warn(`[CopilotProvider] Resume failed for ${key} (${storedSessionId}), creating new session:`, err);
                return this.client.createSession({ model: DEFAULT_MODEL, ...sessionConfig });
            })
            : this.client.createSession({ model: DEFAULT_MODEL, ...sessionConfig }))
            .then((session) => {
            if (this.pending.get(key) !== creation) {
                session.disconnect().catch(() => { });
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
    async evictCachedSession(key, session) {
        if (this.sessions.get(key) === session) {
            this.sessions.delete(key);
        }
        await session.disconnect().catch((err) => console.warn(`[CopilotProvider] Failed to disconnect stale session ${session.sessionId}:`, err));
    }
    abandonTimedOutSession(key, session) {
        if (this.sessions.get(key) === session)
            this.sessions.delete(key);
        this.store.delete(key);
        session.disconnect().catch((err) => console.warn(`[CopilotProvider] Failed to disconnect timed-out session ${session.sessionId}:`, err));
    }
    async withLiveSession(key, operation) {
        return this.enqueueSessionOperation(key, async () => {
            const session = await this.getOrCreateSession(key);
            return this.runWithSessionRecovery(key, session, operation);
        });
    }
    async withExistingLiveSession(key, operation) {
        return this.enqueueSessionOperation(key, async () => {
            const session = this.sessions.get(key);
            if (!session)
                return null;
            return this.runWithSessionRecovery(key, session, operation);
        });
    }
    enqueueSessionOperation(key, operation) {
        const tail = this.sessionOperationQueues.get(key) ?? Promise.resolve();
        const next = tail.catch(() => { }).then(operation);
        const queueTail = next.catch(() => { });
        this.sessionOperationQueues.set(key, queueTail);
        queueTail.finally(() => {
            if (this.sessionOperationQueues.get(key) === queueTail) {
                this.sessionOperationQueues.delete(key);
            }
        });
        return next;
    }
    async runWithSessionRecovery(key, session, operation) {
        try {
            return await operation(session);
        }
        catch (err) {
            if (!isSessionNotFoundError(err))
                throw err;
            console.warn(`[CopilotProvider] Cached session ${session.sessionId} for ${key} was not found by Copilot; evicting stale session and reinitializing.`);
            await this.evictCachedSession(key, session);
            const resumed = await this.getOrCreateSession(key);
            return operation(resumed);
        }
    }
    async sendMessage(userId, prompt, imagePaths, options) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            const attachments = imagePaths?.map((a) => ({
                type: "file",
                path: a.path,
                ...(a.displayName ? { displayName: a.displayName } : {}),
            }));
            return this.withLiveSession(userId, async (session) => {
                try {
                    return await sendUntilIdle(session, { prompt, ...(attachments?.length ? { attachments } : {}) }, options);
                }
                catch (error) {
                    if (error instanceof RunTimeoutError && !error.cancellationConfirmed) {
                        this.abandonTimedOutSession(userId, session);
                    }
                    throw error;
                }
            });
        });
        this.messageQueues.set(userId, next.catch(() => { }));
        return next;
    }
    async getStatus() {
        await this.client.start();
        const [status, authStatus] = await Promise.all([
            this.client.getStatus(),
            this.client.getAuthStatus(),
        ]);
        return { status, authStatus: authStatus };
    }
    async getHistory(userId) {
        const events = await this.withExistingLiveSession(userId, (session) => session.getEvents());
        return events?.map(toHistoryEvent).filter((event) => event !== null) ?? null;
    }
    async listModels() {
        await this.client.start();
        return this.client.listModels();
    }
    async setModel(userId, model) {
        await this.withLiveSession(userId, (session) => session.setModel(model));
    }
    async getCurrentModel(key) {
        const result = await this.withLiveSession(key, (session) => session.rpc.model.getCurrent());
        return result.modelId;
    }
    async listReasoningEfforts() {
        return [...REASONING_EFFORTS];
    }
    async setReasoningEffort(key, effort) {
        const level = effort;
        if (!REASONING_EFFORTS.includes(level)) {
            throw new Error(`Invalid reasoning effort: ${effort}.`);
        }
        await this.withLiveSession(key, (session) => session.rpc.model.setReasoningEffort({ reasoningEffort: effort }));
        this.reasoningEffortOverrides.set(key, level);
    }
    async getCurrentReasoningEffort(key) {
        return this.reasoningEffortOverrides.get(key) ?? DEFAULT_REASONING_EFFORT;
    }
    // ── Agent management ────────────────────────────────────────────────────────
    async listAgents(key) {
        const result = await this.withLiveSession(key, (session) => session.rpc.agent.list());
        return result.agents;
    }
    async getCurrentAgent(key) {
        const result = await this.withLiveSession(key, (session) => session.rpc.agent.getCurrent());
        return result.agent ?? null;
    }
    async selectAgent(key, name) {
        const result = await this.withLiveSession(key, (session) => session.rpc.agent.select({ name }));
        return result.agent;
    }
    async deselectAgent(key) {
        await this.withLiveSession(key, (session) => session.rpc.agent.deselect());
    }
    // ── Session mode ─────────────────────────────────────────────────────────────
    async getMode(key) {
        return this.withLiveSession(key, (session) => session.rpc.mode.get());
    }
    async setMode(key, mode) {
        await this.withLiveSession(key, (session) => session.rpc.mode.set({ mode }));
    }
    // ── Compaction ───────────────────────────────────────────────────────────────
    async compact(key) {
        return this.withLiveSession(key, (session) => session.rpc.history.compact());
    }
    // ── Fleet ────────────────────────────────────────────────────────────────────
    async startFleet(key, prompt) {
        const result = await this.withLiveSession(key, (session) => session.rpc.fleet.start({ prompt }));
        return result.started;
    }
    // ── Plan management ──────────────────────────────────────────────────────────
    async readPlan(key) {
        const result = await this.withLiveSession(key, (session) => session.rpc.plan.read());
        return {
            exists: result.exists,
            content: result.content,
            path: result.path,
        };
    }
    async updatePlan(key, content) {
        await this.withLiveSession(key, (session) => session.rpc.plan.update({ content }));
    }
    async deletePlan(key) {
        await this.withLiveSession(key, (session) => session.rpc.plan.delete());
    }
    // ── Workspace management ─────────────────────────────────────────────────────
    async listWorkspaceFiles(key) {
        const result = await this.withLiveSession(key, (session) => session.rpc.workspaces.listFiles());
        return result.files;
    }
    async readWorkspaceFile(key, filePath) {
        const result = await this.withLiveSession(key, (session) => session.rpc.workspaces.readFile({ path: filePath }));
        return result.content;
    }
    async createWorkspaceFile(key, filePath, content) {
        await this.withLiveSession(key, (session) => session.rpc.workspaces.createFile({ path: filePath, content }));
    }
    async resetSession(key) {
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
            await session.disconnect().catch((err) => console.error(`[CopilotProvider] Error disconnecting session for ${key}:`, err));
        }
        const sessionId = session?.sessionId ?? storedSessionId;
        if (sessionId) {
            await this.client.start();
            await this.client.deleteSession(sessionId).catch((err) => console.error(`[CopilotProvider] Error deleting session ${sessionId}:`, err));
        }
    }
    // --- MCP + Working Directory management ---
    buildMcpConfig(key) {
        const workingDir = this.workingDirOverrides.get(key);
        const base = McpConfigLoader.load(workingDir);
        const overrides = this.mcpToolOverrides.get(key) ?? {};
        const result = {};
        for (const [name, cfg] of Object.entries(base)) {
            if (name in overrides) {
                result[name] = { ...cfg, tools: overrides[name] };
            }
            else {
                result[name] = cfg;
            }
        }
        return result;
    }
    setSessionWorkingDir(key, dir) {
        const canonical = resolveConfiguredWorkspace(dir);
        this.workingDirOverrides.set(key, canonical);
    }
    getSessionWorkingDir(key) {
        return this.workingDirOverrides.get(key);
    }
    setSessionMcpEnabled(key, serverName, enabled) {
        const overrides = this.mcpToolOverrides.get(key) ?? {};
        overrides[serverName] = enabled ? ["*"] : [];
        this.mcpToolOverrides.set(key, overrides);
    }
    getMcpStatus(key) {
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
    async shutdown() {
        const allSessions = Array.from(this.sessions.values());
        this.sessions.clear();
        this.pending.clear();
        this.sessionOperationQueues.clear();
        await Promise.all(allSessions.map((s) => s.disconnect().catch((err) => console.error("[CopilotProvider] Shutdown error:", err))));
        await this.client.stop();
    }
}
