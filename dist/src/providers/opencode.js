import { spawn } from "child_process";
import fs from "fs";
import os from "node:os";
import { ParticipationProcessRunner } from "./participationProcess.js";
import { withOpenCodeServer } from "./openCodeServer.js";
import path from "path";
import { SessionStore } from "../common/sessionStore.js";
import { providerSystemPrompt, withSystemPrompt } from "../common/systemPrompt.js";
import { contextFingerprint, resolveSessionContext, withContextTurn } from "../common/sessionContext.js";
import { captureAgentArtifacts, withArtifactOutputPrompt } from "../common/agentResponse.js";
import { ArtifactToolSessions, artifactInputPrompt } from "../common/artifactToolBridge.js";
import { RulesetToolSessions, rulesetToolPrompt } from "../common/rulesetToolBridge.js";
import { GitHubContributionSessions, githubContributionPrompt } from "../common/githubContributionToolBridge.js";
import { configuredMilliseconds, providerTimeout, startProgressUpdates } from "../common/runLifecycle.js";
import { configuredSecurityMode, ensureProviderWorkingDirectory, providerChildEnvironment, OPENCODE_API_KEY_ENVIRONMENT_KEYS, resolveConfiguredWorkspace, SENSITIVE_DIRECTORY_DENY_GLOBS, SENSITIVE_FILE_DENY_GLOBS, SENSITIVE_PATH_ALLOW_GLOBS, secureSystemPrompt, } from "../common/providerSecurity.js";
import { RunTimeoutError, UnsupportedError } from "./types.js";
/**
 * Resolves the `opencode` executable. Prefers OPENCODE_BIN, then well-known
 * V2 npm-global install locations (Windows + POSIX), and finally falls back to the
 * bare command name so the OS PATH lookup is used (Linux/macOS installs).
 */
function resolveOpenCodeBinary() {
    if (process.env.OPENCODE_BIN)
        return process.env.OPENCODE_BIN;
    // The V2 npm package ships this filename on both Windows and POSIX.
    const binName = "opencode.exe";
    const candidates = [];
    if (process.platform === "win32" && process.env.APPDATA) {
        candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@opencode", "cli", "bin", binName));
    }
    if (process.env.HOME) {
        candidates.push(path.join(process.env.HOME, ".npm-global", "lib", "node_modules", "@opencode", "cli", "bin", binName));
    }
    candidates.push(path.join("/usr", "local", "lib", "node_modules", "@opencode", "cli", "bin", binName));
    candidates.push(path.join("/usr", "lib", "node_modules", "@opencode", "cli", "bin", binName));
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
function openCodeAgentName(systemPrompt) {
    return `ai-assistant-${contextFingerprint(systemPrompt).slice(0, 16)}`;
}
function openCodeMcpServer(config, execution) {
    return { type: "local", command: [config.command, ...config.args], environment: config.env,
        disabled: false, codemode: false, timeout: { catalog: 120_000, execution },
    };
}
/** Native V2 rules are ordered; the last matching permission wins. */
export function openCodeSecurityConfig() {
    const sensitivePathPolicy = [
        { resource: "*", effect: "allow" },
        ...SENSITIVE_FILE_DENY_GLOBS.map(resource => ({ resource, effect: "deny" })),
        ...SENSITIVE_PATH_ALLOW_GLOBS.map(resource => ({ resource, effect: "allow" })),
        // OpenCode uses the last matching rule, so credential-directory denials must win.
        ...SENSITIVE_DIRECTORY_DENY_GLOBS.map(resource => ({ resource, effect: "deny" })),
    ];
    return {
        plugins: [],
        permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...["read", "edit"].flatMap(action => sensitivePathPolicy.map(rule => ({ action, ...rule }))),
            ...["glob", "list", "webfetch", "websearch", "question", "todowrite", "todoread"].map(action => ({ action, resource: "*", effect: "allow" })),
            // OpenCode matches grep permissions against the regex, not searched paths, so
            // path-based secret exclusions cannot secure it. File reads remain available.
            // LSP servers are repository-controlled child processes and would inherit provider credentials.
            ...["grep", "lsp", "external_directory", "shell", "subagent", "skill"].map(action => ({ action, resource: "*", effect: "deny" })),
        ],
    };
}
/** Hide ambient configuration without moving the persistent session/credential database. */
export function openCodeIsolatedEnvironment(source, directory) {
    return { ...source,
        HOME: directory, USERPROFILE: directory,
        XDG_DATA_HOME: source.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
        XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
        OPENCODE_CONFIG_DIR: path.join(directory, "config"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    };
}
export function openCodeChildEnvironment(source = process.env, artifacts, rulesets, systemPrompt, agentName, github) {
    const environment = providerChildEnvironment("opencode", source);
    if (artifacts || rulesets || github || systemPrompt) {
        const config = configuredSecurityMode(source) === "shared" ? openCodeSecurityConfig()
            : JSON.parse(environment.OPENCODE_CONFIG_CONTENT || "{}");
        if (systemPrompt) {
            const name = agentName ?? openCodeAgentName(systemPrompt);
            config.agents = {
                ...config.agents,
                [name]: { mode: "primary", system: secureSystemPrompt(systemPrompt, { ...source, AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: github ? "true" : "false" }) },
            };
        }
        const servers = { ...config.mcp?.servers };
        config.mcp = { ...config.mcp, servers };
        // Keep an existing legacy policy in its original format when adding grants;
        // introducing a competing native field is unnecessary for V1-format config.
        const grant = (action) => {
            if (config.permissions || config.permission === undefined) {
                config.permissions = [...(config.permissions ?? []), { action, resource: "*", effect: "allow" }];
            }
            else {
                config.permission = { ...(typeof config.permission === "string" ? { "*": config.permission } : config.permission), [action]: "allow" };
            }
        };
        delete servers.github_contributions;
        if (github) {
            servers.github_contributions = openCodeMcpServer(github, 120_000);
            grant("github_contributions_*");
        }
        if (artifacts) {
            servers.artifact_tools = openCodeMcpServer(artifacts, 960_000);
            grant("artifact_tools_*");
        }
        if (rulesets) {
            servers.ruleset_tools = openCodeMcpServer(rulesets, 120_000);
            grant("ruleset_tools_*");
        }
        return { ...environment, OPENCODE_DISABLE_AUTOUPDATE: "1",
            ...(configuredSecurityMode(source) === "shared" ? { OPENCODE_DISABLE_PROJECT_CONFIG: "1" } : {}),
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    }
    if (configuredSecurityMode(source) === "unrestricted") {
        return { ...environment, OPENCODE_DISABLE_AUTOUPDATE: "1" };
    }
    return {
        ...environment,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeSecurityConfig()),
    };
}
export function openCodeBaseRunArguments() {
    return ["run", "--format", "json", "--auto"];
}
export function openCodeRequestPrompt(prompt) {
    return configuredSecurityMode() === "shared"
        ? `${secureSystemPrompt(providerSystemPrompt())}\n\n${prompt}`
        : withSystemPrompt(prompt);
}
/** Keep classification on the configured connection, preferring a small model. */
export function selectOpenCodeParticipationModel(models, current) {
    const connection = current?.split("/")[0];
    const candidates = connection ? models.filter(model => model.startsWith(`${connection}/`)) : models;
    for (const suffix of ["/gpt-5.6-luna", "/claude-haiku-4.5", "/gpt-4.1-mini"]) {
        const match = candidates.find(model => model.endsWith(suffix));
        if (match)
            return match;
    }
    if (current)
        return current;
    throw new Error("Set CHAT_PARTICIPATION_MODEL to a small model available in OpenCode.");
}
export function assertOpenCodeV2(version) {
    const match = /^(?:opencode\s+)?v?2\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\s*$/i.exec(version.trim());
    if (!match || (Number(match[1]) === 0 && Number(match[2]) < 31)) {
        throw new Error("OpenCode V2 (2.0.31 or newer) is required. Install @opencode/cli@2.0.31 and update OPENCODE_BIN if set.");
    }
}
let verifiedBinary;
async function runOpenCode(args, opts) {
    const binary = openCodeBin();
    const isolation = configuredSecurityMode() === "shared" ? fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-opencode-")) : undefined;
    try {
        const base = openCodeChildEnvironment(process.env, opts.artifacts, opts.rulesets, opts.systemPrompt, opts.agentName, opts.github);
        const env = isolation ? openCodeIsolatedEnvironment(base, isolation) : base;
        if (verifiedBinary !== binary) {
            const version = await executeOpenCode(binary, ["--version"], opts, env);
            if (version.code !== 0)
                throw new Error("Could not read the OpenCode version.");
            assertOpenCodeV2(version.stdout);
            verifiedBinary = binary;
        }
        if (args[0] === "run") {
            const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
            const mcpServers = Object.entries(config.mcp?.servers ?? {}).filter(([, server]) => !server.disabled).map(([name]) => name);
            return await withOpenCodeServer(binary, { ...opts, env, mcpServers }, (url, environment, signal) => executeOpenCode(binary, ["run", "--server", url, ...args.slice(1)], { ...opts, signal }, environment));
        }
        const command = args[0] === "--version" ? args : [...args, "--standalone"];
        return await executeOpenCode(binary, command, opts, env);
    }
    finally {
        if (isolation)
            fs.rmSync(isolation, { recursive: true, force: true });
    }
}
function executeOpenCode(binary, args, opts, env) {
    return new Promise((resolve, reject) => {
        const cancellationGraceMs = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5_000);
        const child = spawn(binary, args, {
            cwd: opts.cwd,
            signal: opts.signal,
            killSignal: "SIGKILL",
            stdio: ["ignore", "pipe", "pipe"],
            env,
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
    store;
    participationProcesses = new ParticipationProcessRunner();
    artifactTools = new ArtifactToolSessions();
    rulesetTools = new RulesetToolSessions();
    githubTools = new GitHubContributionSessions();
    name = "opencode";
    displayName = "OpenCode";
    sessions = new Map(); // key -> opencode session id (live)
    constructor(store = new SessionStore('opencode')) {
        this.store = store;
    }
    histories = new Map();
    workingDirOverrides = new Map();
    modelOverrides = new Map();
    messageQueues = new Map();
    participationModels;
    configuredModel() {
        return process.env.OPENCODE_MODEL?.trim() || undefined;
    }
    workingDir(key) {
        return this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory();
    }
    async sendMessage(userId, prompt, imagePaths, options) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            options?.signal?.throwIfAborted();
            const args = openCodeBaseRunArguments();
            const sessionId = this.sessions.get(userId) ?? this.store.get(userId);
            if (sessionId)
                args.push("--session", sessionId);
            const model = this.modelOverrides.get(userId) ?? this.configuredModel();
            if (model)
                args.push("--model", model);
            const context = resolveSessionContext({ transportContext: options?.transportContext, profile: options?.contextProfile, userInstructionContext: options?.userInstructionContext });
            const systemPrompt = context.systemPrompt;
            const agentName = openCodeAgentName(systemPrompt);
            args.push("--agent", agentName);
            const timeoutMs = providerTimeout("OPENCODE_TIMEOUT_MS", options);
            this.appendHistory(userId, { type: "user.message", data: { content: prompt } });
            const workingDirectory = this.workingDir(userId);
            const runWithRulesetTools = (action) => context.rulesetsEnabled
                ? this.rulesetTools.run(userId, options, (rulesetRuntime) => action(rulesetRuntime))
                : action();
            const response = await this.githubTools.run(userId, options, context.githubContributionsEnabled, githubRun => runWithRulesetTools(async (rulesetRuntime) => captureAgentArtifacts(workingDirectory, (artifactRun) => this.artifactTools.run(userId, artifactRun, imagePaths, options, async (_runtime, staged) => {
                for (const file of staged.filter((file) => !file.binary))
                    args.push("--file", file.path);
                const basePrompt = withArtifactOutputPrompt(artifactInputPrompt(withContextTurn(prompt, { userInstructionContext: options?.userInstructionContext }), staged), artifactRun, options?.transportContext);
                args.push(githubContributionPrompt(rulesetRuntime ? rulesetToolPrompt(basePrompt, rulesetRuntime) : basePrompt, githubRun));
                const stopProgress = startProgressUpdates(options);
                const { stdout, stderr, code } = await runOpenCode(args, {
                    cwd: workingDirectory,
                    signal: options?.signal,
                    timeoutMs,
                    providerName: this.displayName,
                    artifacts: await this.artifactTools.config(userId, options?.transportContext),
                    rulesets: context.rulesetsEnabled ? await this.rulesetTools.config(userId) : undefined,
                    github: context.githubContributionsEnabled ? await this.githubTools.config(userId) : undefined,
                    systemPrompt,
                    agentName,
                }).finally(stopProgress);
                if (code !== 0) {
                    const detail = stderr.trim() || stdout.trim();
                    throw new Error(detail || "opencode run failed");
                }
                const events = parseEvents(stdout);
                const newSessionId = sessionIdFromEvents(events);
                if (newSessionId) {
                    this.sessions.set(userId, newSessionId);
                    this.store.set(userId, newSessionId, context.applied);
                }
                return finalTextFromEvents(events) || (options?.transportContext?.attachments ? "" : "(no response)");
            }), Boolean(options?.transportContext?.attachments))));
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
    async evaluateParticipation(prompt, options) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-classifier-"));
        const started = Date.now();
        try {
            const dataDirectory = path.join(directory, "data");
            const config = {
                plugins: [], mcp: { servers: {} },
                permissions: [{ action: "*", resource: "*", effect: "deny" }],
                agents: { build: { permissions: [{ action: "*", resource: "*", effect: "deny" }] } },
            };
            const source = openCodeIsolatedEnvironment(providerChildEnvironment("opencode", { ...process.env, AI_ASSISTANT_SECURITY_MODE: "shared" }), directory);
            const env = {
                ...source,
                XDG_DATA_HOME: dataDirectory, XDG_STATE_HOME: path.join(directory, "state"),
                OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
                OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
            };
            const run = (args, environment = env, stdin) => {
                const remaining = options.timeoutMs - (Date.now() - started);
                if (remaining <= 0)
                    throw new Error("Participation evaluator timed out during setup.");
                return this.participationProcesses.run(openCodeBin(), args, { cwd: directory, timeoutMs: remaining, env: environment, stdin });
            };
            assertOpenCodeV2(await run(["--version"]));
            // V2 stores credentials in SQLite. Transfer only credentials, never the user's
            // conversations; keep secrets in memory and the private, disposable database.
            const credentials = await run(["auth", "export", "--standalone"], { ...source, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) });
            await run(["auth", "import", "--standalone"], env, credentials);
            if (!options.model && !this.participationModels) {
                const listed = await run(["models", "--standalone"]);
                this.participationModels = listed.split("\n").map(line => line.trim()).filter(line => /^[^\s/]+\/[^\s]+$/.test(line));
            }
            const model = options.model ?? selectOpenCodeParticipationModel(this.participationModels, options.connectionModel ?? this.configuredModel());
            if (model.endsWith("/gpt-5.6-luna")) {
                const slash = model.indexOf("/");
                env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config,
                    providers: { [model.slice(0, slash)]: { models: { [model.slice(slash + 1)]: { settings: { reasoningEffort: options.effort } } } } },
                });
            }
            const stdout = await run(["run", "--format", "json", "--standalone", "--title", "Participation", "--model", model, prompt]);
            return finalTextFromEvents(parseEvents(stdout));
        }
        finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
    async getStatus() {
        let version = "unknown";
        try {
            const res = await runOpenCode(["--version"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 30_000 });
            version = res.stdout.trim().replace(/^opencode\s+/i, "") || version;
        }
        catch (err) {
            console.warn("[OpenCodeProvider] Failed to read opencode version:", err);
        }
        const environmentKey = OPENCODE_API_KEY_ENVIRONMENT_KEYS.find(key => process.env[key]?.trim());
        let isAuthenticated = Boolean(environmentKey);
        let login = environmentKey;
        try {
            const res = await runOpenCode(["auth", "list", "--format", "json"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 30_000 });
            const integrations = res.code === 0 ? JSON.parse(res.stdout) : [];
            isAuthenticated ||= Array.isArray(integrations) && integrations.length > 0;
            login ??= isAuthenticated ? "opencode auth (stored credentials or provider environment)" : undefined;
        }
        catch (err) {
            console.warn("[OpenCodeProvider] Failed to read opencode auth:", err);
        }
        return {
            status: { version: `opencode ${version}` },
            authStatus: {
                isAuthenticated,
                login,
                authType: environmentKey ? "environment API key" : isAuthenticated ? "opencode credentials or provider environment" : "opencode auth login",
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
    async forgetSession(key) {
        await this.resetSession(key);
        this.workingDirOverrides.delete(key);
        this.modelOverrides.delete(key);
    }
    async resetSession(key) {
        await this.artifactTools.reset(key);
        await this.rulesetTools.reset(key);
        await this.githubTools.reset(key);
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
        await this.participationProcesses.shutdown();
        await this.artifactTools.shutdown();
        await this.rulesetTools.shutdown();
        await this.githubTools.shutdown();
        this.sessions.clear();
        this.messageQueues.clear();
    }
}
