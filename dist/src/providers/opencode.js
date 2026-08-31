import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { SessionStore } from "../common/sessionStore.js";
import { configuredSystemPrompt, withSystemPrompt } from "../common/systemPrompt.js";
import { configuredMilliseconds, startProgressUpdates } from "../common/runLifecycle.js";
import { configuredSecurityMode, ensureProviderWorkingDirectory, providerChildEnvironment, resolveConfiguredWorkspace, SENSITIVE_PATH_ALLOW_GLOBS, SENSITIVE_PATH_DENY_GLOBS, secureSystemPrompt, } from "../common/providerSecurity.js";
import { RunTimeoutError, UnsupportedError } from "./types.js";
/**
 * Resolves the `opencode` executable. Prefers OPENCODE_BIN, then well-known
 * npm-global install locations (Windows + POSIX), and finally falls back to the
 * bare command name so the OS PATH lookup is used (Linux/macOS installs).
 */
function resolveOpenCodeBinary() {
    if (process.env.OPENCODE_BIN)
        return process.env.OPENCODE_BIN;
    const binName = process.platform === "win32" ? "opencode.exe" : "opencode";
    const candidates = [];
    if (process.platform === "win32" && process.env.APPDATA) {
        candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", binName));
    }
    if (process.env.HOME) {
        candidates.push(path.join(process.env.HOME, ".npm-global", "lib", "node_modules", "opencode-ai", "bin", binName));
    }
    candidates.push(path.join("/usr", "local", "lib", "node_modules", "opencode-ai", "bin", binName));
    candidates.push(path.join("/usr", "lib", "node_modules", "opencode-ai", "bin", binName));
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate))
                return candidate;
        }
        catch {
            // keep trying
        }
    }
    return "opencode"; // rely on PATH lookup
}
function openCodeBin() {
    return resolveOpenCodeBinary();
}
/** Inline policy has the highest normal config precedence in OpenCode v1. */
export function openCodeSecurityConfig() {
    const sensitivePathPolicy = Object.fromEntries([
        ["*", "allow"],
        ...SENSITIVE_PATH_DENY_GLOBS.map((glob) => [glob, "deny"]),
        ...SENSITIVE_PATH_ALLOW_GLOBS.map((glob) => [glob, "allow"]),
    ]);
    return {
        autoupdate: false,
        share: "disabled",
        plugin: [],
        permission: {
            "*": "deny",
            read: sensitivePathPolicy,
            edit: sensitivePathPolicy,
            glob: "allow",
            // OpenCode matches grep permissions against the regex, not searched paths, so
            // path-based secret exclusions cannot secure it. File reads remain available.
            grep: "deny",
            list: "allow",
            // LSP servers are repository-controlled child processes and would inherit provider credentials.
            lsp: "deny",
            webfetch: "allow",
            websearch: "allow",
            question: "allow",
            todowrite: "allow",
            todoread: "allow",
            external_directory: "deny",
            bash: "deny",
            task: "deny",
            skill: "deny",
        },
    };
}
export function openCodeChildEnvironment(source = process.env) {
    const environment = providerChildEnvironment("opencode", source);
    if (configuredSecurityMode(source) === "unrestricted") {
        return { ...environment, OPENCODE_DISABLE_AUTOUPDATE: "1" };
    }
    return {
        ...environment,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeSecurityConfig()),
    };
}
export function openCodeBaseRunArguments(source = process.env) {
    return [
        "run",
        "--format",
        "json",
        ...(configuredSecurityMode(source) === "shared" ? ["--pure"] : []),
        "--auto",
    ];
}
export function openCodeRequestPrompt(prompt) {
    return configuredSecurityMode() === "shared"
        ? `${secureSystemPrompt(configuredSystemPrompt())}\n\n${prompt}`
        : withSystemPrompt(prompt);
}
/**
 * Runs the `opencode` CLI non-interactively and returns its stdout.
 * Uses spawn (no shell) so prompts/arguments are never interpreted by a shell.
 */
function runOpenCode(args, opts) {
    return new Promise((resolve, reject) => {
        const cancellationGraceMs = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5_000);
        const child = spawn(openCodeBin(), args, {
            cwd: opts.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env: openCodeChildEnvironment(),
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let cancellationDeadline;
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        let timedOut = false;
        let cancellationRequested = false;
        const timer = setTimeout(() => {
            timedOut = true;
            cancellationRequested = child.kill("SIGKILL");
            cancellationDeadline = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new RunTimeoutError(opts.providerName ?? "OpenCode", opts.timeoutMs, false));
            }, cancellationGraceMs);
        }, opts.timeoutMs);
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(cancellationDeadline);
            reject(timedOut ? new RunTimeoutError(opts.providerName ?? "OpenCode", opts.timeoutMs, false) : err);
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(cancellationDeadline);
            if (timedOut) {
                reject(new RunTimeoutError(opts.providerName ?? "OpenCode", opts.timeoutMs, cancellationRequested));
                return;
            }
            resolve({ stdout, stderr, code });
        });
    });
}
function parseEvents(stdout) {
    const events = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (trimmed.startsWith("{")) {
            try {
                events.push(JSON.parse(trimmed));
            }
            catch {
                // Ignore non-JSON progress lines
            }
        }
    }
    return events;
}
function sessionIdFromEvents(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].sessionID)
            return events[i].sessionID;
    }
    return undefined;
}
function finalTextFromEvents(events) {
    const texts = events
        .filter((e) => e.type === "text" && typeof e.part?.text === "string")
        .map((e) => e.part.text)
        .filter((t) => t.trim().length > 0);
    return texts.at(-1) ?? "";
}
/**
 * Session manager backed by the OpenCode CLI. Sessions are mapped 1:1 to
 * OpenCode session IDs (persisted via `SessionStore`) and continued with
 * `opencode run --session <id>`. Features the headless CLI does not expose for
 * this bot (plan/workspace/mode/fleet, etc.) throw `UnsupportedError`.
 */
export class OpenCodeProvider {
    name = "opencode";
    displayName = "OpenCode";
    sessions = new Map(); // key -> opencode session id (live)
    store = new SessionStore(this.name);
    histories = new Map();
    workingDirOverrides = new Map();
    modelOverrides = new Map();
    messageQueues = new Map();
    configuredModel() {
        return process.env.OPENCODE_MODEL?.trim() || undefined;
    }
    workingDir(key) {
        return this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory();
    }
    async sendMessage(userId, prompt, imagePaths, options) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            const args = openCodeBaseRunArguments();
            const sessionId = this.sessions.get(userId) ?? this.store.get(userId);
            if (sessionId)
                args.push("--session", sessionId);
            const model = this.modelOverrides.get(userId) ?? this.configuredModel();
            if (model)
                args.push("--model", model);
            for (const img of imagePaths ?? []) {
                args.push("--file", img.path);
            }
            args.push(openCodeRequestPrompt(prompt));
            const timeoutMs = configuredMilliseconds("OPENCODE_TIMEOUT_MS", 60 * 60 * 1000);
            this.appendHistory(userId, { type: "user.message", data: { content: prompt } });
            const stopProgress = startProgressUpdates(options);
            const { stdout, stderr, code } = await runOpenCode(args, {
                cwd: this.workingDir(userId), timeoutMs, providerName: this.displayName,
            }).finally(stopProgress);
            if (code !== 0) {
                const detail = stderr.trim() || stdout.trim();
                throw new Error(detail || "opencode run failed");
            }
            const events = parseEvents(stdout);
            const newSessionId = sessionIdFromEvents(events);
            if (newSessionId) {
                this.sessions.set(userId, newSessionId);
                this.store.set(userId, newSessionId);
            }
            const response = finalTextFromEvents(events) || "(no response)";
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
    async getStatus() {
        let version = "unknown";
        try {
            const res = await runOpenCode(["--version"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 30_000 });
            version = res.stdout.trim() || version;
        }
        catch (err) {
            console.warn("[OpenCodeProvider] Failed to read opencode version:", err);
        }
        let isAuthenticated = false;
        let login;
        try {
            const res = await runOpenCode(["auth", "list"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 30_000 });
            isAuthenticated = res.code === 0;
            // Very loose: expose auth.json path as the login label.
            login = isAuthenticated ? "opencode auth (see ~/.local/share/opencode/auth.json)" : undefined;
        }
        catch (err) {
            console.warn("[OpenCodeProvider] Failed to read opencode auth:", err);
        }
        return {
            status: { version: `opencode ${version}` },
            authStatus: {
                isAuthenticated,
                login,
                authType: isAuthenticated ? "opencode credentials file" : "opencode auth login",
                host: "local",
                statusMessage: isAuthenticated
                    ? undefined
                    : "Run `opencode auth login` to configure a provider.",
            },
        };
    }
    async getHistory(userId) {
        if (!this.sessions.has(userId) && !this.store.get(userId))
            return null;
        return this.histories.get(userId) ?? [];
    }
    async listModels() {
        let stdout = "";
        try {
            const res = await runOpenCode(["models"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 60_000 });
            stdout = res.stdout;
        }
        catch (err) {
            console.warn("[OpenCodeProvider] Failed to list models:", err);
        }
        const models = [];
        for (const line of stdout.split("\n")) {
            const id = line.trim();
            if (id)
                models.push({ id, name: id });
        }
        return models;
    }
    async setModel(userId, model) {
        this.modelOverrides.set(userId, model);
        this.sessions.delete(userId);
    }
    async getCurrentModel(key) {
        return this.modelOverrides.get(key) ?? this.configuredModel();
    }
    // The remaining features require session/agent/bookkeeping the headless
    // `opencode run` flow does not expose for this bot.
    async listReasoningEfforts() {
        throw new UnsupportedError(this.displayName, "reasoning effort control");
    }
    async setReasoningEffort() {
        throw new UnsupportedError(this.displayName, "reasoning effort control");
    }
    async getCurrentReasoningEffort() {
        throw new UnsupportedError(this.displayName, "reasoning effort control");
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
        const sessionId = this.sessions.get(key) ?? this.store.get(key);
        this.sessions.delete(key);
        this.store.delete(key);
        this.histories.delete(key);
        this.messageQueues.delete(key);
        if (sessionId) {
            try {
                await runOpenCode(["session", "delete", sessionId], {
                    cwd: this.workingDir(key),
                    timeoutMs: 30_000,
                });
            }
            catch (err) {
                console.warn(`[OpenCodeProvider] Failed to delete opencode session ${sessionId}:`, err);
            }
        }
    }
    setSessionWorkingDir(key, dir) {
        const canonical = resolveConfiguredWorkspace(dir);
        this.workingDirOverrides.set(key, canonical);
        this.sessions.delete(key);
    }
    getSessionWorkingDir(key) {
        return this.workingDirOverrides.get(key);
    }
    setSessionMcpEnabled() {
        throw new UnsupportedError(this.displayName, "MCP server toggling");
    }
    getMcpStatus() {
        return [];
    }
    async shutdown() {
        this.sessions.clear();
        this.messageQueues.clear();
    }
}
