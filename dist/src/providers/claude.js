import os from "node:os";
import path from "node:path";
import { AbortError, deleteSession, getSessionMessages, query, } from "@anthropic-ai/claude-agent-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { resolveSessionContext, withContextTurn } from "../common/sessionContext.js";
import { captureAgentArtifacts, withArtifactOutputPrompt } from "../common/agentResponse.js";
import { ArtifactToolSessions, artifactInputPrompt } from "../common/artifactToolBridge.js";
import { RulesetToolSessions, rulesetToolPrompt } from "../common/rulesetToolBridge.js";
import { GitHubContributionSessions, githubContributionPrompt } from "../common/githubContributionToolBridge.js";
import { githubContributionsEnabled } from "../common/githubContributionConfig.js";
import { configuredMilliseconds, providerTimeout, startProgressUpdates } from "../common/runLifecycle.js";
import { configuredSecurityMode, configuredWorkspaceRoot, ensureProviderWorkingDirectory, pathIsWithin, providerChildEnvironment, resolveConfiguredWorkspace, workspacePathIsAllowed, } from "../common/providerSecurity.js";
import { RunTimeoutError, UnsupportedError, } from "./types.js";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
const DEFAULT_CLAUDE_PARTICIPATION_MODEL = "claude-haiku-5-5";
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_CLAUDE_EFFORT = "medium";
/** Built-in tools available in shared mode. Bash, Grep and subagents are excluded. */
export const CLAUDE_SHARED_TOOLS = ["Read", "Write", "Edit", "Glob", "WebFetch", "WebSearch", "TodoWrite"];
function configuredClaudeModel() {
    return process.env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
}
function parseClaudeEffort(value) {
    const effort = CLAUDE_EFFORTS.find((level) => level === value.trim().toLowerCase());
    if (!effort)
        throw new Error(`Invalid Claude reasoning effort: ${value} (expected ${CLAUDE_EFFORTS.join(", ")})`);
    return effort;
}
function configuredClaudeEffort() {
    const configured = process.env.CLAUDE_REASONING_EFFORT?.trim();
    return configured ? parseClaudeEffort(configured) : DEFAULT_CLAUDE_EFFORT;
}
export function configuredClaudeFastMode(source = process.env) {
    const configured = source.CLAUDE_FAST_MODE?.trim().toLowerCase();
    if (!configured || configured === "false")
        return false;
    if (configured === "true")
        return true;
    throw new Error("Invalid CLAUDE_FAST_MODE: expected true or false");
}
function stringField(input, field) {
    if (!input || typeof input !== "object" || !(field in input))
        return undefined;
    const value = Reflect.get(input, field);
    return typeof value === "string" ? value : undefined;
}
/**
 * Shared-mode policy for one tool call, mirroring the Copilot permission handler:
 * file access stays inside the workspace and off sensitive paths, only host MCP
 * servers run, and shell execution is unavailable.
 */
export function claudeToolDecision(workingDirectory, toolName, input, githubEnabled = githubContributionsEnabled()) {
    const deny = (reason) => ({ allow: false, reason });
    const fileDecision = (filePath, action) => filePath && workspacePathIsAllowed(workingDirectory, filePath)
        ? { allow: true }
        : deny(`${action} are limited to non-sensitive files in the assigned workspace.`);
    if (toolName.startsWith("mcp__")) {
        const server = toolName.split("__")[1];
        const allowed = server === "artifact_tools" || server === "ruleset_tools" || (server === "github_contributions" && githubEnabled);
        return allowed ? { allow: true } : deny("Only host-provided MCP tools are enabled for shared sessions.");
    }
    switch (toolName) {
        case "Read":
            return fileDecision(stringField(input, "file_path"), "Reads");
        case "Write":
        case "Edit":
            return fileDecision(stringField(input, "file_path"), "Writes");
        case "Glob": {
            const pattern = stringField(input, "pattern") ?? "";
            if (pattern.startsWith("/") || pattern.split(/[\\/]/).includes(".."))
                return deny("Glob patterns must stay inside the workspace.");
            return fileDecision(stringField(input, "path") ?? workingDirectory, "Searches");
        }
        case "WebFetch":
        case "WebSearch":
        case "TodoWrite":
            return { allow: true };
        case "Bash":
            return deny("Arbitrary shell execution is disabled for this shared provider.");
        default:
            return deny("This capability is not enabled for shared sessions.");
    }
}
function sharedToolHook(workingDirectory) {
    return async (input) => {
        if (input.hook_event_name !== "PreToolUse")
            return {};
        const decision = claudeToolDecision(workingDirectory, input.tool_name, input.tool_input);
        return {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: decision.allow ? "allow" : "deny",
                ...(decision.allow ? {} : { permissionDecisionReason: decision.reason }),
            },
        };
    };
}
/**
 * Builds SDK options for one turn. Shared mode isolates the CLI from user and
 * project settings, restricts the tool set and gates every call through a
 * PreToolUse hook that blocks if the hook itself fails. Unrestricted mode keeps
 * the operator's Claude Code configuration and skips permission prompts.
 */
export function claudeQueryOptions(params, source = process.env) {
    const base = {
        cwd: params.workingDirectory,
        model: params.model,
        effort: params.effort,
        settings: { fastMode: params.fastMode },
        // Render the host prompt fresh each turn so changed instructions or rulesets reach resumed sessions.
        systemPrompt: { type: "preset", preset: "claude_code", append: params.systemPrompt, snapshot: false },
        mcpServers: params.mcpServers,
        mcpServersDelivery: "initialize",
        env: providerChildEnvironment("claude", source),
        ...(params.resume ? { resume: params.resume } : {}),
        ...(params.abortController ? { abortController: params.abortController } : {}),
    };
    if (configuredSecurityMode(source) === "unrestricted") {
        return { ...base, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
    }
    assertClaudeStateOutsideWorkspace(source);
    return {
        ...base,
        // Mentions would expand files before the hook sees them; memory would leak operator context.
        env: { ...base.env, CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" },
        settings: { fastMode: params.fastMode, autoMemoryEnabled: false },
        settingSources: [],
        strictMcpConfig: true,
        tools: CLAUDE_SHARED_TOOLS,
        permissionMode: "default",
        hooks: { PreToolUse: [{ hooks: [sharedToolHook(params.workingDirectory)], onFailure: "block" }] },
        // The hook decides every call; anything still asking has no interactive approver.
        canUseTool: async () => ({ behavior: "deny", message: "Interactive approval is unavailable in shared sessions." }),
    };
}
/** True when `candidate` is `root` or below it, lexically or through symlinks. */
function overlaps(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    const lexicallyInside = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    return lexicallyInside || pathIsWithin(root, candidate);
}
/**
 * Claude's login and transcripts must stay unreachable from shared file tools, whatever the folder is named.
 * The default `~/.claude` inside a HOME workspace is already denied by name; a workspace inside Claude state never is.
 */
function assertClaudeStateOutsideWorkspace(source) {
    const root = configuredWorkspaceRoot(source);
    if (!root)
        return;
    const explicit = source.CLAUDE_CONFIG_DIR?.trim();
    // The child resolves a relative path against its workspace cwd, not the bot's, so only absolute paths are checkable.
    if (explicit && !path.isAbsolute(explicit))
        throw new Error("CLAUDE_CONFIG_DIR must be an absolute path in shared mode.");
    const configDir = explicit || path.join(source.HOME?.trim() || os.homedir(), ".claude");
    if (overlaps(configDir, root) || (explicit && overlaps(root, explicit))) {
        throw new Error("The provider workspace root and Claude's config directory must not overlap, including symlink targets.");
    }
}
function stdioServer(config) {
    return { type: "stdio", command: config.command, args: config.args, env: config.env };
}
async function collectTurn(messages) {
    const turn = { text: "" };
    for await (const message of messages) {
        if ("session_id" in message && message.session_id)
            turn.sessionId = message.session_id;
        if (message.type !== "result")
            continue;
        if (message.subtype === "success") {
            if (message.is_error)
                throw new Error(message.result || "Claude returned an error result.");
            turn.text = message.result;
        }
        else {
            throw new Error(message.errors.join("\n") || `Claude run failed (${message.subtype}).`);
        }
    }
    return turn;
}
function textContent(message) {
    if (!message || typeof message !== "object" || !("content" in message))
        return "";
    const { content } = message;
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((block) => (block && typeof block === "object" && "type" in block && block.type === "text" ? stringField(block, "text") ?? "" : ""))
        .join("");
}
function isMissingSessionError(error) {
    return error instanceof Error && /no conversation found|session.*not found/i.test(error.message);
}
/**
 * Session manager backed by the Claude Agent SDK. Each turn is a one-shot
 * `query()` that resumes the stored Claude Code session for the key, so history
 * lives in Claude Code's own session files and survives restarts.
 */
export class ClaudeProvider {
    store;
    name = "claude";
    displayName = "Claude";
    artifactTools = new ArtifactToolSessions();
    rulesetTools = new RulesetToolSessions();
    githubTools = new GitHubContributionSessions();
    workingDirOverrides = new Map();
    modelOverrides = new Map();
    effortOverrides = new Map();
    fastModeOverrides = new Map();
    messageQueues = new Map();
    activeRuns = new Set();
    constructor(store = new SessionStore("claude")) {
        this.store = store;
    }
    workingDir(key) {
        return this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory();
    }
    async sendMessage(userId, prompt, imagePaths, options) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(() => this.runTurn(userId, prompt, imagePaths, options));
        this.messageQueues.set(userId, next.catch(() => { }));
        return next;
    }
    async runTurn(key, prompt, imagePaths, options) {
        options?.signal?.throwIfAborted();
        const context = resolveSessionContext({ transportContext: options?.transportContext, profile: options?.contextProfile, userInstructionContext: options?.userInstructionContext, sitesSupported: false });
        const workingDirectory = this.workingDir(key);
        const timeoutMs = providerTimeout("CLAUDE_TIMEOUT_MS", options);
        const runWithRulesetTools = (action) => context.rulesetsEnabled ? this.rulesetTools.run(key, options, (runtime) => action(runtime)) : action();
        return this.githubTools.run(key, options, context.githubContributionsEnabled, (githubRun) => runWithRulesetTools((rulesetRuntime) => captureAgentArtifacts(workingDirectory, (artifactRun) => this.artifactTools.run(key, artifactRun, imagePaths, options, async (_runtime, staged) => {
            // Wraps request text in this turn's host tool envelope (staged inputs, run IDs, tool guidance).
            const withEnvelope = (text) => {
                const basePrompt = withArtifactOutputPrompt(artifactInputPrompt(withContextTurn(text, { userInstructionContext: options?.userInstructionContext }), staged), artifactRun, options?.transportContext);
                return githubContributionPrompt(rulesetRuntime ? rulesetToolPrompt(basePrompt, rulesetRuntime) : basePrompt, githubRun);
            };
            const mcpServers = {
                artifact_tools: stdioServer(await this.artifactTools.config(key, options?.transportContext)),
                ...(context.rulesetsEnabled ? { ruleset_tools: stdioServer(await this.rulesetTools.config(key)) } : {}),
                ...(context.githubContributionsEnabled ? { github_contributions: stdioServer(await this.githubTools.config(key)) } : {}),
            };
            const turnOptions = {
                workingDirectory,
                model: this.modelOverrides.get(key) ?? configuredClaudeModel(),
                effort: this.effortOverrides.get(key) ?? configuredClaudeEffort(),
                fastMode: this.fastModeOverrides.get(key) ?? configuredClaudeFastMode(),
                systemPrompt: context.systemPrompt,
                mcpServers,
            };
            const stopProgress = startProgressUpdates(options);
            try {
                const resume = this.store.get(key);
                let turn;
                try {
                    turn = await this.runQuery(withEnvelope(prompt), { ...turnOptions, resume }, timeoutMs, options?.signal);
                }
                catch (error) {
                    if (!resume || !isMissingSessionError(error))
                        throw error;
                    console.warn(`[ClaudeProvider] Session ${resume} for ${key} is gone; starting a new one.`);
                    this.store.delete(key);
                    turn = await this.runQuery(withEnvelope(options?.onSessionRecovery?.() ?? prompt), turnOptions, timeoutMs, options?.signal);
                }
                options?.signal?.throwIfAborted();
                if (turn.sessionId)
                    this.store.set(key, turn.sessionId, context.applied);
                return turn.text || (options?.transportContext?.attachments ? "" : "(no response)");
            }
            finally {
                stopProgress();
            }
        }), Boolean(options?.transportContext?.attachments))));
    }
    /** Runs one query with host cancellation and a hard timeout that waits briefly for confirmation. */
    async runQuery(prompt, params, timeoutMs, signal) {
        // Setup is async; a cancellation during it must not start a paid run.
        signal?.throwIfAborted();
        const abortController = new AbortController();
        const onAbort = () => abortController.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.activeRuns.add(abortController);
        const run = query({ prompt, options: claudeQueryOptions({ ...params, abortController }) });
        const collected = collectTurn(run);
        collected.catch(() => { });
        let timer;
        const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
        try {
            const outcome = await Promise.race([collected, timedOut]);
            if (outcome !== "timeout")
                return outcome;
            abortController.abort();
            const grace = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5000);
            const settled = collected.then(() => true, () => true);
            const cancelled = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve(false), grace))]);
            throw new RunTimeoutError(this.displayName, timeoutMs, cancelled);
        }
        catch (error) {
            if (signal?.aborted && !(error instanceof RunTimeoutError))
                throw signal.reason ?? new AbortError();
            throw error;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            this.activeRuns.delete(abortController);
            run.close();
        }
    }
    /** Classifies without tools, settings, MCP servers or a persisted session. */
    async evaluateParticipation(prompt, options) {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), options.timeoutMs);
        const run = query({
            prompt,
            options: {
                abortController,
                model: options.model ?? DEFAULT_CLAUDE_PARTICIPATION_MODEL,
                effort: "low",
                tools: [],
                settingSources: [],
                strictMcpConfig: true,
                mcpServers: {},
                persistSession: false,
                maxTurns: 1,
                cwd: ensureProviderWorkingDirectory(),
                env: { ...providerChildEnvironment("claude", { ...process.env, AI_ASSISTANT_SECURITY_MODE: "shared" }), CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" },
                settings: { autoMemoryEnabled: false },
                systemPrompt: "Classify the supplied conversation using the supplied policy. Return only the decision JSON.",
                canUseTool: async () => ({ behavior: "deny", message: "Classification has no tool permissions." }),
            },
        });
        try {
            return (await collectTurn(run)).text;
        }
        catch (error) {
            if (abortController.signal.aborted)
                throw new Error("Participation evaluator timed out.");
            throw error;
        }
        finally {
            clearTimeout(timer);
            run.close();
        }
    }
    /** Opens an idle control session for account and model metadata without sending a turn. */
    async withControlQuery(action) {
        const idle = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => { }) }) };
        const control = query({
            prompt: idle,
            options: { cwd: ensureProviderWorkingDirectory(), env: providerChildEnvironment("claude"), settingSources: [], strictMcpConfig: true, persistSession: false },
        });
        try {
            return await action(control);
        }
        finally {
            control.close();
        }
    }
    async getStatus() {
        try {
            const [account, init] = await this.withControlQuery((control) => Promise.all([control.accountInfo(), control.initializationResult()]));
            // Claude Code reports "none" for an absent credential source.
            const source = [account.apiKeySource, account.tokenSource].find((value) => value && value !== "none");
            const isAuthenticated = Boolean(account.email || source || (account.apiProvider && account.apiProvider !== "firstParty"));
            return {
                status: { version: `Claude Code ${init.claude_code_version ?? "unknown"}` },
                authStatus: {
                    isAuthenticated,
                    login: account.email ?? account.organization,
                    authType: account.subscriptionType ?? source,
                    host: account.apiProvider ?? "firstParty",
                    ...(isAuthenticated ? {} : { statusMessage: "Run `claude /login`, or set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN." }),
                },
            };
        }
        catch (error) {
            return {
                status: {},
                authStatus: {
                    isAuthenticated: false,
                    statusMessage: `Claude Code is unavailable: ${error instanceof Error ? error.message : String(error)}. Run \`claude /login\` or set ANTHROPIC_API_KEY.`,
                },
            };
        }
    }
    async getHistory(userId) {
        const sessionId = this.store.get(userId);
        if (!sessionId)
            return null;
        const messages = await getSessionMessages(sessionId, { dir: this.workingDir(userId) }).catch(() => []);
        return messages.flatMap((entry) => {
            const content = textContent(entry.message);
            if (!content)
                return [];
            if (entry.type === "user")
                return [{ type: "user.message", data: { content } }];
            if (entry.type === "assistant")
                return [{ type: "assistant.message", data: { content, ...(entry.parent_tool_use_id ? { parentToolCallId: entry.parent_tool_use_id } : {}) } }];
            return [];
        });
    }
    async listModels() {
        const models = await this.withControlQuery((control) => control.supportedModels());
        return models.map((model) => ({ id: model.value, name: model.displayName }));
    }
    async setModel(userId, model) {
        this.modelOverrides.set(userId, model);
    }
    async getCurrentModel(key) {
        return this.modelOverrides.get(key) ?? configuredClaudeModel();
    }
    async setFastMode(key, enabled) {
        this.fastModeOverrides.set(key, enabled);
    }
    async getFastMode(key) {
        return this.fastModeOverrides.get(key) ?? configuredClaudeFastMode();
    }
    async listReasoningEfforts() {
        return [...CLAUDE_EFFORTS];
    }
    async setReasoningEffort(key, effort) {
        this.effortOverrides.set(key, parseClaudeEffort(effort));
    }
    async getCurrentReasoningEffort(key) {
        return this.effortOverrides.get(key) ?? configuredClaudeEffort();
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
        this.effortOverrides.delete(key);
        this.fastModeOverrides.delete(key);
    }
    async resetSession(key) {
        await this.artifactTools.reset(key);
        await this.rulesetTools.reset(key);
        await this.githubTools.reset(key);
        const sessionId = this.store.get(key);
        this.store.delete(key);
        this.messageQueues.delete(key);
        if (sessionId) {
            await deleteSession(sessionId, { dir: this.workingDir(key) }).catch((error) => {
                console.warn(`[ClaudeProvider] Failed to delete Claude session ${sessionId}:`, error);
            });
        }
    }
    setSessionWorkingDir(key, dir) {
        const canonical = resolveConfiguredWorkspace(dir);
        // Claude Code stores sessions per project directory, so a new workspace starts fresh.
        if (this.workingDir(key) !== canonical)
            this.store.delete(key);
        this.workingDirOverrides.set(key, canonical);
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
        for (const run of this.activeRuns)
            run.abort();
        this.activeRuns.clear();
        await this.artifactTools.shutdown();
        await this.rulesetTools.shutdown();
        await this.githubTools.shutdown();
        this.messageQueues.clear();
    }
}
