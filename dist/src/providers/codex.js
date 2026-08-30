import fs from "fs";
import { createRequire } from "node:module";
import os from "os";
import path from "path";
import { Codex } from "@openai/codex-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, UnsupportedError, } from "./types.js";
import { readFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
function configuredCodexModel() {
    return process.env.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL;
}
function configuredCodexReasoningEffort() {
    const configured = process.env.CODEX_REASONING_EFFORT?.trim().toLowerCase();
    if (!configured)
        return DEFAULT_REASONING_EFFORT;
    if (!REASONING_EFFORTS.includes(configured)) {
        throw new Error(`Invalid CODEX_REASONING_EFFORT: ${configured} (expected ${REASONING_EFFORTS.join(", ")})`);
    }
    return configured;
}
function isThreadNotFoundError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /(thread|session).*(not found|missing|unknown)/i.test(message);
}
function isCachedCodexModel(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Session manager backed by the OpenAI Codex SDK. Each Provider method maps to
 * a Codex thread; features the SDK does not expose throw `UnsupportedError`.
 */
export class CodexProvider {
    name = "codex";
    displayName = "OpenAI Codex";
    client;
    sessions = new Map();
    pending = new Map();
    sessionOperationQueues = new Map();
    messageQueues = new Map();
    store = new SessionStore(this.name);
    histories = new Map();
    workingDirOverrides = new Map();
    modelOverrides = new Map();
    reasoningEffortOverrides = new Map();
    mcpToolOverrides = new Map();
    constructor() {
        this.client = new Codex({
            ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
        });
    }
    threadOptions(key) {
        const workingDirectory = this.workingDirOverrides.get(key) ?? process.cwd();
        return {
            model: this.modelOverrides.get(key) ?? configuredCodexModel(),
            modelReasoningEffort: this.reasoningEffortOverrides.get(key) ?? configuredCodexReasoningEffort(),
            workingDirectory,
            skipGitRepoCheck: true,
            approvalPolicy: "never",
            sandboxMode: "danger-full-access",
            networkAccessEnabled: true,
        };
    }
    async getOrCreateSession(key) {
        const existing = this.sessions.get(key);
        if (existing)
            return existing;
        const inFlight = this.pending.get(key);
        if (inFlight)
            return inFlight;
        const storedThreadId = this.store.get(key);
        const creation = Promise.resolve(storedThreadId
            ? this.client.resumeThread(storedThreadId, this.threadOptions(key))
            : this.client.startThread(this.threadOptions(key)))
            .then((thread) => {
            if (this.pending.get(key) !== creation)
                return thread;
            this.sessions.set(key, thread);
            this.pending.delete(key);
            if (thread.id)
                this.store.set(key, thread.id);
            return thread;
        })
            .catch((err) => {
            if (this.pending.get(key) === creation)
                this.pending.delete(key);
            if (!storedThreadId)
                throw err;
            console.warn(`[CodexProvider] Resume failed for ${key} (${storedThreadId}), starting a new Codex thread:`, err);
            this.store.delete(key);
            const fresh = this.client.startThread(this.threadOptions(key));
            this.sessions.set(key, fresh);
            return fresh;
        });
        this.pending.set(key, creation);
        return creation;
    }
    evictCachedSession(key, thread) {
        if (this.sessions.get(key) === thread)
            this.sessions.delete(key);
    }
    async withLiveSession(key, operation) {
        return this.enqueueSessionOperation(key, async () => {
            const thread = await this.getOrCreateSession(key);
            return this.runWithSessionRecovery(key, thread, operation);
        });
    }
    async withExistingLiveSession(key, operation) {
        return this.enqueueSessionOperation(key, async () => {
            const thread = this.sessions.get(key);
            if (!thread)
                return null;
            return this.runWithSessionRecovery(key, thread, operation);
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
    async runWithSessionRecovery(key, thread, operation) {
        try {
            return await operation(thread);
        }
        catch (err) {
            if (!isThreadNotFoundError(err))
                throw err;
            console.warn(`[CodexProvider] Cached Codex thread for ${key} was not found; starting a new thread.`);
            this.evictCachedSession(key, thread);
            this.store.delete(key);
            const fresh = await this.getOrCreateSession(key);
            return operation(fresh);
        }
    }
    async sendMessage(userId, prompt, imagePaths) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            const images = imagePaths?.filter((attachment) => attachment.kind !== "file") ?? [];
            const files = imagePaths?.filter((attachment) => attachment.kind === "file") ?? [];
            const fileContext = await Promise.all(files.map(async (attachment) => {
                const text = await readFile(attachment.path, "utf8");
                return `[Discord attachment: ${attachment.displayName ?? "file"}]\n${text}\n[/Discord attachment]`;
            }));
            const resolvedPrompt = fileContext.length ? `${prompt}\n\n${fileContext.join("\n\n")}` : prompt;
            const input = images.length > 0
                ? [
                    { type: "text", text: resolvedPrompt },
                    ...images.map((a) => ({ type: "local_image", path: a.path })),
                ]
                : resolvedPrompt;
            this.appendHistory(userId, { type: "user.message", data: { content: prompt } });
            const timeoutMs = parseInt(process.env.CODEX_TIMEOUT_MS ?? "", 10) || 10 * 60 * 1000;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            const result = await this.withLiveSession(userId, (thread) => thread.run(input, { signal: controller.signal })).finally(() => clearTimeout(timeout));
            if (result && this.sessions.get(userId)?.id) {
                this.store.set(userId, this.sessions.get(userId).id);
            }
            const response = result.finalResponse || this.extractFinalResponse(result.items) || "(no response)";
            this.appendHistory(userId, { type: "assistant.message", data: { content: response } });
            return response;
        });
        this.messageQueues.set(userId, next.catch(() => { }));
        return next;
    }
    appendHistory(key, event) {
        const history = this.histories.get(key) ?? [];
        history.push(event);
        this.histories.set(key, history.slice(-100));
    }
    extractFinalResponse(items) {
        const agentMessages = items
            .filter((item) => item.type === "agent_message")
            .map((item) => item.text)
            .filter(Boolean);
        return agentMessages.at(-1) ?? null;
    }
    async getStatus() {
        let version = "unknown";
        try {
            const pkg = require("@openai/codex/package.json");
            version = pkg.version ? `@openai/codex ${pkg.version}` : version;
        }
        catch (err) {
            console.warn("[CodexProvider] Failed to read Codex package version:", err);
        }
        return {
            status: { version },
            authStatus: {
                isAuthenticated: Boolean(process.env.OPENAI_API_KEY),
                login: process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : undefined,
                authType: process.env.OPENAI_API_KEY ? "api-key" : "Codex CLI login or OPENAI_API_KEY",
                host: process.env.OPENAI_BASE_URL ?? "api.openai.com",
                statusMessage: process.env.OPENAI_API_KEY
                    ? undefined
                    : "Codex may still use an existing CLI login; no OPENAI_API_KEY is set in this process.",
            },
        };
    }
    async getHistory(userId) {
        return this.withExistingLiveSession(userId, async () => this.histories.get(userId) ?? []);
    }
    async listModels() {
        const modelsById = new Map();
        for (const model of this.readCachedCodexModels()) {
            modelsById.set(model.id, model);
        }
        const configured = [configuredCodexModel(), ...this.modelOverrides.values()].filter((model) => Boolean(model));
        for (const id of configured) {
            if (!modelsById.has(id))
                modelsById.set(id, { id, name: id });
        }
        return Array.from(modelsById.values());
    }
    readCachedCodexModels() {
        const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
        const cachePath = path.join(codexHome, "models_cache.json");
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        }
        catch {
            return [];
        }
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) {
            return [];
        }
        const models = parsed.models
            .filter(isCachedCodexModel)
            .filter((model) => typeof model.slug === "string")
            .filter((model) => model.visibility !== "hide")
            .sort((a, b) => {
            const aPriority = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
            const bPriority = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
            return aPriority - bPriority;
        });
        return models.map((model) => {
            const id = model.slug;
            return {
                id,
                name: typeof model.display_name === "string" ? model.display_name : id,
            };
        });
    }
    async setModel(userId, model) {
        this.modelOverrides.set(userId, model);
        this.sessions.delete(userId);
    }
    async getCurrentModel(key) {
        return this.modelOverrides.get(key) ?? configuredCodexModel();
    }
    async listReasoningEfforts() {
        return [...REASONING_EFFORTS];
    }
    async setReasoningEffort(key, effort) {
        const level = effort;
        if (!REASONING_EFFORTS.includes(level)) {
            throw new Error(`Invalid reasoning effort: ${effort}.`);
        }
        this.reasoningEffortOverrides.set(key, level);
        this.sessions.delete(key);
    }
    async getCurrentReasoningEffort(key) {
        return this.reasoningEffortOverrides.get(key) ?? configuredCodexReasoningEffort();
    }
    async listAgents() {
        throw new UnsupportedError(this.displayName, "custom agent listing");
    }
    async getCurrentAgent() {
        throw new UnsupportedError(this.displayName, "custom agent selection");
    }
    async selectAgent() {
        throw new UnsupportedError(this.displayName, "custom agent selection");
    }
    async deselectAgent() {
        throw new UnsupportedError(this.displayName, "custom agent selection");
    }
    async getMode() {
        throw new UnsupportedError(this.displayName, "session mode switching");
    }
    async setMode() {
        throw new UnsupportedError(this.displayName, "session mode switching");
    }
    async compact() {
        throw new UnsupportedError(this.displayName, "history compaction");
    }
    async startFleet() {
        throw new UnsupportedError(this.displayName, "fleet mode");
    }
    async readPlan() {
        throw new UnsupportedError(this.displayName, "plan management");
    }
    async updatePlan() {
        throw new UnsupportedError(this.displayName, "plan management");
    }
    async deletePlan() {
        throw new UnsupportedError(this.displayName, "plan management");
    }
    async listWorkspaceFiles() {
        throw new UnsupportedError(this.displayName, "workspace file listing");
    }
    async readWorkspaceFile() {
        throw new UnsupportedError(this.displayName, "workspace file reading");
    }
    async createWorkspaceFile() {
        throw new UnsupportedError(this.displayName, "workspace file creation");
    }
    async resetSession(key) {
        this.sessions.delete(key);
        this.pending.delete(key);
        this.sessionOperationQueues.delete(key);
        this.messageQueues.delete(key);
        this.histories.delete(key);
        this.store.delete(key);
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
        this.sessions.delete(key);
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
            const skipped = !s.enabled;
            if (skipped)
                return { ...s, enabled: false, skipped: true };
            if (s.name in overrides)
                return { ...s, enabled: overrides[s.name].length > 0, skipped: false };
            return { ...s, skipped: false };
        });
    }
    async shutdown() {
        this.sessions.clear();
        this.pending.clear();
        this.sessionOperationQueues.clear();
        this.messageQueues.clear();
    }
}
