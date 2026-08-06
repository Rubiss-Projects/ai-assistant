import fs from "fs";
import os from "os";
import path from "path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, } from "./types.js";
const DEFAULT_MODEL = process.env.COPILOT_MODEL?.trim() || "claude-haiku-4.5";
function isSessionNotFoundError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /Session not found:/i.test(message);
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
        this.client = new CopilotClient();
    }
    async getOrCreateSession(key) {
        const existing = this.sessions.get(key);
        if (existing)
            return existing;
        const inFlight = this.pending.get(key);
        if (inFlight)
            return inFlight;
        const userSkillsDir = path.join(os.homedir(), ".agents", "skills");
        const workingDir = this.workingDirOverrides.get(key);
        const mcpServers = this.buildMcpConfig(key);
        const sessionConfig = {
            onPermissionRequest: approveAll,
            skillDirectories: [userSkillsDir],
            ...(workingDir ? { workingDirectory: workingDir } : {}),
            ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
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
    async sendMessage(userId, prompt, imagePaths) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            const attachments = imagePaths?.map((a) => ({
                type: "file",
                path: a.path,
                ...(a.displayName ? { displayName: a.displayName } : {}),
            }));
            const result = await this.withLiveSession(userId, (session) => session.sendAndWait({ prompt, ...(attachments?.length ? { attachments } : {}) }, parseInt(process.env.COPILOT_TIMEOUT_MS ?? "") || 10 * 60 * 1000 // default 10-minute timeout
            ));
            return result?.data?.content ?? "(no response)";
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
        return events ?? null;
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
        if (!dir || dir.includes("\0")) {
            throw new Error("Invalid workspace path.");
        }
        let canonical;
        try {
            canonical = fs.realpathSync.native(path.resolve(dir));
        }
        catch {
            throw new Error(`Workspace path does not exist: ${path.resolve(dir)}`);
        }
        if (!fs.statSync(canonical).isDirectory()) {
            throw new Error(`Workspace path is not a directory: ${canonical}`);
        }
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
