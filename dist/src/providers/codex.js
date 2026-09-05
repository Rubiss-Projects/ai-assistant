import fs from "fs";
import { createRequire } from "node:module";
import os from "os";
import path from "path";
import { Codex } from "@openai/codex-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import { providerSystemPrompt } from "../common/systemPrompt.js";
import { captureAgentArtifacts, withArtifactOutputPrompt } from "../common/agentResponse.js";
import { UserVisibleError } from "../common/userVisibleError.js";
import { configuredMilliseconds, startProgressUpdates } from "../common/runLifecycle.js";
import { configuredSecurityMode, configuredSitesEnabled, ensureProviderWorkingDirectory, providerChildEnvironment, resolveConfiguredWorkspace, SENSITIVE_DIRECTORY_DENY_GLOBS, SENSITIVE_FILE_DENY_GLOBS, SENSITIVE_PATH_ALLOW_GLOBS, secureSystemPrompt, } from "../common/providerSecurity.js";
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, UnsupportedError, RunTimeoutError, } from "./types.js";
import { readFile, stat } from "node:fs/promises";
const require = createRequire(import.meta.url);
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_INLINE_ATTACHMENT_BYTES = 200_000;
const MAX_CODEX_INLINE_ATTACHMENT_BYTES = 1_000_000;
// Codex app policy keys are catalog connector IDs, not tool namespace/display names.
export const CODEX_SITES_CONNECTOR_ID = "connector_20205bf7d4e99a89d7154bb849718324";
export const CODEX_SITES_GIT_HOST = "git.chatgpt-team.site";
export const CODEX_GITHUB_READ_ONLY_TOOLS = [
    "get_repo",
    "fetch",
    "fetch_file",
    "search_repositories",
];
const CODEX_PERMISSION_PROFILE = "discord-bot";
export function createCodexSessionTemporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-codex-"));
    fs.chmodSync(directory, 0o700);
    return directory;
}
export function codexFilesystemPermissionOverride(sitesEnabled = false) {
    const sensitiveRules = [
        ...SENSITIVE_FILE_DENY_GLOBS.map((glob) => `${JSON.stringify(glob)}="deny"`),
        ...SENSITIVE_PATH_ALLOW_GLOBS.map((glob) => `${JSON.stringify(glob)}="write"`),
        ...(sitesEnabled
            ? [".openai", ".openai/**"]
                .map((glob) => `${JSON.stringify(glob)}="write"`)
            : []),
        // Directory denials come last so no nested filename exception can override them.
        ...SENSITIVE_DIRECTORY_DENY_GLOBS.map((glob) => `${JSON.stringify(glob)}="deny"`),
    ].join(",");
    return `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read",":tmpdir"="write",glob_scan_max_depth=8,":workspace_roots"={"."="write",${sensitiveRules}}}`;
}
export function codexThreadSecurityOptions(source = process.env) {
    return configuredSecurityMode(source) === "unrestricted"
        ? { sandboxMode: "danger-full-access", networkAccessEnabled: true }
        : {};
}
function shellEnvironment(workingDirectory, childEnvironment) {
    const allowedNames = new Set([
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
        "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE", "SSL_CERT_DIR",
    ]);
    const result = Object.fromEntries(Object.entries(childEnvironment).filter(([name]) => allowedNames.has(name.toUpperCase())));
    result.HOME = workingDirectory;
    result.USERPROFILE = workingDirectory;
    return result;
}
/** Host-owned settings that Discord prompts and project config cannot relax. */
export function codexClientOptions(temporaryDirectory) {
    const systemPrompt = providerSystemPrompt();
    if (configuredSecurityMode() === "unrestricted") {
        return {
            ...(process.env.CODEX_EXECUTABLE_PATH?.trim()
                ? { codexPathOverride: process.env.CODEX_EXECUTABLE_PATH.trim() }
                : {}),
            ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
            ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
            config: { developer_instructions: systemPrompt },
        };
    }
    if (!temporaryDirectory) {
        throw new Error("Shared Codex clients require an isolated temporary directory.");
    }
    const workingDirectory = ensureProviderWorkingDirectory();
    const sitesEnabled = configuredSitesEnabled();
    const childEnvironment = Object.fromEntries(Object.entries(providerChildEnvironment("codex"))
        .filter(([name]) => !["TEMP", "TMP", "TMPDIR"].includes(name.toUpperCase())));
    childEnvironment.TEMP = temporaryDirectory;
    childEnvironment.TMP = temporaryDirectory;
    childEnvironment.TMPDIR = temporaryDirectory;
    const tools = Object.fromEntries(CODEX_GITHUB_READ_ONLY_TOOLS.map((tool) => [tool, { enabled: true, approval_mode: "approve" }]));
    return {
        ...(process.env.CODEX_EXECUTABLE_PATH?.trim()
            ? { codexPathOverride: process.env.CODEX_EXECUTABLE_PATH.trim() }
            : {}),
        ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
        env: childEnvironment,
        config: {
            developer_instructions: secureSystemPrompt(systemPrompt),
            ...(!process.env.OPENAI_API_KEY ? { forced_login_method: "chatgpt" } : {}),
            default_permissions: CODEX_PERMISSION_PROFILE,
            features: {
                apps: true,
                network_proxy: sitesEnabled,
                hooks: false,
                plugins: sitesEnabled,
                remote_plugin: false,
                memories: false,
                computer_use: false,
                browser_use: false,
                browser_use_external: false,
                shell_snapshot: false,
                skill_mcp_dependency_install: false,
                workspace_dependencies: false,
            },
            shell_environment_policy: {
                inherit: "none",
                ignore_default_excludes: false,
                experimental_use_profile: false,
                set: shellEnvironment(workingDirectory, childEnvironment),
            },
            apps: {
                _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
                github: {
                    enabled: true,
                    default_tools_enabled: false,
                    destructive_enabled: false,
                    open_world_enabled: false,
                    tools,
                },
                ...(sitesEnabled
                    ? {
                        [CODEX_SITES_CONNECTOR_ID]: {
                            enabled: true,
                            default_tools_enabled: true,
                            default_tools_approval_mode: "approve",
                            destructive_enabled: false,
                            open_world_enabled: true,
                        },
                    }
                    : {}),
            },
        },
        configOverrides: [
            "mcp_servers={}",
            codexFilesystemPermissionOverride(sitesEnabled),
            sitesEnabled
                ? `permissions.${CODEX_PERMISSION_PROFILE}.network={enabled=true,mode="full",allow_local_binding=false,allow_upstream_proxy=false,domains={"${CODEX_SITES_GIT_HOST}"="allow"}}`
                : `permissions.${CODEX_PERMISSION_PROFILE}.network={enabled=false}`,
        ],
    };
}
function configuredInlineAttachmentLimit() {
    return Math.min(configuredMilliseconds("CODEX_MAX_INLINE_ATTACHMENT_BYTES", DEFAULT_CODEX_INLINE_ATTACHMENT_BYTES, 1), MAX_CODEX_INLINE_ATTACHMENT_BYTES);
}
async function readCodexTextAttachment(attachment) {
    const displayName = attachment.displayName ?? path.basename(attachment.path);
    const limit = configuredInlineAttachmentLimit();
    const metadata = await stat(attachment.path);
    if (metadata.size > limit) {
        throw new UserVisibleError(`Attachment \`${displayName}\` is too large to send to Codex as text (${metadata.size} bytes; limit ${limit}).`);
    }
    const text = await readFile(attachment.path, "utf8");
    if (text.length > limit) {
        throw new UserVisibleError(`Attachment \`${displayName}\` is too large to send to Codex as text (${text.length} characters; limit ${limit}).`);
    }
    return text;
}
function normalizedEventKind(value) {
    return typeof value === "string" ? value.replace(/[^a-z]/gi, "").toLowerCase() : "";
}
export function codexGeneratedImagePaths(event) {
    const paths = new Set();
    const visit = (value, imageContext = false, completedContext = false) => {
        if (!value || typeof value !== "object")
            return;
        if (Array.isArray(value)) {
            for (const item of value)
                visit(item, imageContext, completedContext);
            return;
        }
        const record = value;
        const descriptors = [record.type, record.name, record.kind, record.event].map(normalizedEventKind);
        const isImage = imageContext || descriptors.some((kind) => kind.includes("imagegeneration"));
        const isCompleted = completedContext
            || record.status === "completed"
            || descriptors.includes("itemcompleted");
        if (isImage && isCompleted && typeof record.savedPath === "string")
            paths.add(record.savedPath);
        for (const child of Object.values(record))
            visit(child, isImage, isCompleted);
    };
    visit(event);
    return [...paths];
}
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
function codexGeneratedImagesRoot() {
    return path.join(path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex")), "generated_images");
}
function generatedImageThreadDirectory(threadId) {
    if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId))
        return undefined;
    return path.join(codexGeneratedImagesRoot(), threadId);
}
function snapshotThreadGeneratedImages(threadId) {
    const directory = generatedImageThreadDirectory(threadId);
    const snapshot = new Map();
    if (!directory)
        return snapshot;
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    }
    catch {
        return snapshot;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !/\.(?:gif|jpe?g|png|webp)$/i.test(entry.name))
            continue;
        try {
            const metadata = fs.lstatSync(path.join(directory, entry.name));
            if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
                continue;
            snapshot.set(entry.name, `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`);
        }
        catch {
            // A concurrently removed file cannot be a completed output for this turn.
        }
    }
    return snapshot;
}
function newThreadGeneratedImages(threadId, before) {
    const directory = generatedImageThreadDirectory(threadId);
    if (!directory)
        return [];
    const after = snapshotThreadGeneratedImages(threadId);
    return [...after]
        .filter(([name, identity]) => before.get(name) !== identity)
        .map(([name]) => path.join(directory, name));
}
async function runCodexCapturingEvents(thread, input, signal) {
    const threadIdBeforeRun = thread.id;
    const generatedImagesBeforeRun = snapshotThreadGeneratedImages(threadIdBeforeRun);
    const filesystemGeneratedImages = () => {
        const threadIdAfterRun = thread.id;
        const before = threadIdBeforeRun === threadIdAfterRun ? generatedImagesBeforeRun : new Map();
        return newThreadGeneratedImages(threadIdAfterRun, before);
    };
    if (typeof thread.runStreamed !== "function") {
        const result = await thread.run(input, { signal });
        return {
            finalResponse: result.finalResponse,
            items: result.items,
            generatedImagePaths: [...new Set([
                    ...codexGeneratedImagePaths(result.items),
                    ...filesystemGeneratedImages(),
                ])],
        };
    }
    const streamed = await thread.runStreamed(input, { signal });
    const items = [];
    const generatedImagePaths = new Set();
    let finalResponse = "";
    for await (const event of streamed.events) {
        for (const savedPath of codexGeneratedImagePaths(event))
            generatedImagePaths.add(savedPath);
        const record = event;
        if (record.type === "item.completed" && record.item) {
            items.push(record.item);
            if (record.item.type === "agent_message")
                finalResponse = record.item.text;
        }
        else if (record.type === "turn.failed") {
            throw new Error(record.error?.message || "Codex turn failed.");
        }
    }
    for (const savedPath of filesystemGeneratedImages())
        generatedImagePaths.add(savedPath);
    return { finalResponse, items, generatedImagePaths: [...generatedImagePaths] };
}
/**
 * Session manager backed by the OpenAI Codex SDK. Each Provider method maps to
 * a Codex thread; features the SDK does not expose throw `UnsupportedError`.
 */
export class CodexProvider {
    name = "codex";
    displayName = "OpenAI Codex";
    clients = new Map();
    temporaryDirectories = new Map();
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
    clientFor(key) {
        const existing = this.clients.get(key);
        if (existing)
            return existing;
        let temporaryDirectory;
        if (configuredSecurityMode() === "shared") {
            temporaryDirectory = createCodexSessionTemporaryDirectory();
            this.temporaryDirectories.set(key, temporaryDirectory);
        }
        const client = new Codex(codexClientOptions(temporaryDirectory));
        this.clients.set(key, client);
        return client;
    }
    threadOptions(key) {
        const workingDirectory = this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory();
        const options = {
            model: this.modelOverrides.get(key) ?? configuredCodexModel(),
            modelReasoningEffort: this.reasoningEffortOverrides.get(key) ?? configuredCodexReasoningEffort(),
            workingDirectory,
            skipGitRepoCheck: true,
            approvalPolicy: "never",
            ...codexThreadSecurityOptions(),
        };
        return options;
    }
    async getOrCreateSession(key) {
        const existing = this.sessions.get(key);
        if (existing)
            return existing;
        const inFlight = this.pending.get(key);
        if (inFlight)
            return inFlight;
        const storedThreadId = this.store.get(key);
        const client = this.clientFor(key);
        const creation = Promise.resolve(storedThreadId
            ? client.resumeThread(storedThreadId, this.threadOptions(key))
            : client.startThread(this.threadOptions(key)))
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
            const fresh = client.startThread(this.threadOptions(key));
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
    abandonTimedOutSession(key) {
        this.sessions.delete(key);
        this.pending.delete(key);
        this.sessionOperationQueues.delete(key);
        this.store.delete(key);
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
    async sendMessage(userId, prompt, imagePaths, options) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            const images = imagePaths?.filter((attachment) => attachment.kind !== "file") ?? [];
            const files = imagePaths?.filter((attachment) => attachment.kind === "file") ?? [];
            const fileContext = await Promise.all(files.map(async (attachment) => {
                const text = await readCodexTextAttachment(attachment);
                return `[Discord attachment: ${attachment.displayName ?? "file"}]\n${text}\n[/Discord attachment]`;
            }));
            const resolvedPrompt = fileContext.length ? `${prompt}\n\n${fileContext.join("\n\n")}` : prompt;
            this.appendHistory(userId, { type: "user.message", data: { content: prompt } });
            const workingDirectory = this.workingDirOverrides.get(userId) ?? ensureProviderWorkingDirectory();
            const response = await captureAgentArtifacts(workingDirectory, async (artifactRun) => {
                const artifactPrompt = withArtifactOutputPrompt(resolvedPrompt, artifactRun);
                const input = images.length > 0
                    ? [
                        { type: "text", text: artifactPrompt },
                        ...images.map((a) => ({ type: "local_image", path: a.path })),
                    ]
                    : artifactPrompt;
                const timeoutMs = configuredMilliseconds("CODEX_TIMEOUT_MS", 60 * 60 * 1000);
                const controller = new AbortController();
                let timedOut = false;
                const stopProgress = startProgressUpdates(options);
                let abortGrace;
                let timeout;
                const cancellationGraceMs = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5_000);
                let result;
                try {
                    const run = this.withLiveSession(userId, (thread) => runCodexCapturingEvents(thread, input, controller.signal));
                    const deadline = new Promise((_resolve, reject) => {
                        timeout = setTimeout(() => {
                            timedOut = true;
                            controller.abort();
                            abortGrace = setTimeout(() => {
                                this.abandonTimedOutSession(userId);
                                reject(new RunTimeoutError(this.displayName, timeoutMs, false));
                            }, cancellationGraceMs);
                        }, timeoutMs);
                    });
                    result = await Promise.race([run, deadline]);
                    if (timedOut) {
                        this.abandonTimedOutSession(userId);
                        throw new RunTimeoutError(this.displayName, timeoutMs, true);
                    }
                }
                catch (error) {
                    if (timedOut && !(error instanceof RunTimeoutError)) {
                        this.abandonTimedOutSession(userId);
                        throw new RunTimeoutError(this.displayName, timeoutMs, true);
                    }
                    throw error;
                }
                finally {
                    clearTimeout(timeout);
                    clearTimeout(abortGrace);
                    stopProgress();
                }
                if (result && this.sessions.get(userId)?.id) {
                    this.store.set(userId, this.sessions.get(userId).id);
                }
                const finalResponse = result.finalResponse || this.extractFinalResponse(result.items) || "(no response)";
                const generatedRoot = codexGeneratedImagesRoot();
                return {
                    content: finalResponse,
                    fallbackArtifacts: result.generatedImagePaths.map((savedPath, index) => ({
                        path: savedPath,
                        trustedRoot: generatedRoot,
                        displayName: `generated-image-${index + 1}${path.extname(savedPath)}`,
                    })),
                };
            });
            this.appendHistory(userId, { type: "assistant.message", data: { content: response.content } });
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
        this.clients.delete(key);
        const temporaryDirectory = this.temporaryDirectories.get(key);
        this.temporaryDirectories.delete(key);
        if (temporaryDirectory)
            fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    setSessionWorkingDir(key, dir) {
        const canonical = resolveConfiguredWorkspace(dir);
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
