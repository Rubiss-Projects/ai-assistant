import fs from "fs";
import { createRequire } from "node:module";
import os from "os";
import path from "path";
import { Codex, Thread, type CodexOptions, type ThreadItem, type ThreadOptions, type UserInput } from "@openai/codex-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import { configuredSystemPrompt } from "../common/systemPrompt.js";
import { configuredMilliseconds, startProgressUpdates } from "../common/runLifecycle.js";
import {
  configuredSecurityMode,
  configuredSitesEnabled,
  ensureProviderWorkingDirectory,
  providerChildEnvironment,
  resolveConfiguredWorkspace,
  secureSystemPrompt,
} from "../common/providerSecurity.js";
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
  type SendMessageOptions,
  RunTimeoutError,
  type SessionMode,
  type StatusInfo,
} from "./types.js";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const CODEX_GITHUB_READ_ONLY_TOOLS = [
  "get_repo",
  "fetch",
  "fetch_file",
  "search_repositories",
] as const;

const CODEX_PERMISSION_PROFILE = "discord-bot";

export function codexThreadSecurityOptions(
  source: Record<string, string | undefined> = process.env,
): Pick<ThreadOptions, "sandboxMode" | "networkAccessEnabled"> {
  return configuredSecurityMode(source) === "unrestricted"
    ? { sandboxMode: "danger-full-access", networkAccessEnabled: true }
    : {};
}

function shellEnvironment(workingDirectory: string): Record<string, string> {
  const childEnvironment = providerChildEnvironment("codex");
  const allowedNames = new Set([
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]);
  const result = Object.fromEntries(
    Object.entries(childEnvironment).filter(([name]) => allowedNames.has(name.toUpperCase())),
  );
  result.HOME = workingDirectory;
  result.USERPROFILE = workingDirectory;
  return result;
}

/** Host-owned settings that Discord prompts and project config cannot relax. */
export function codexClientOptions(): CodexOptions {
  const systemPrompt = configuredSystemPrompt();
  if (configuredSecurityMode() === "unrestricted") {
    return {
      ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
      ...(systemPrompt ? { config: { developer_instructions: systemPrompt } } : {}),
    };
  }

  const workingDirectory = ensureProviderWorkingDirectory();
  const sitesEnabled = configuredSitesEnabled();
  const tools = Object.fromEntries(
    CODEX_GITHUB_READ_ONLY_TOOLS.map((tool) => [tool, { enabled: true, approval_mode: "approve" }]),
  );

  return {
    ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    env: providerChildEnvironment("codex"),
    config: {
      developer_instructions: secureSystemPrompt(systemPrompt),
      ...(!process.env.OPENAI_API_KEY ? { forced_login_method: "chatgpt" } : {}),
      default_permissions: CODEX_PERMISSION_PROFILE,
      features: {
        apps: true,
        network_proxy: true,
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
        set: shellEnvironment(workingDirectory),
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
              sites: {
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
      `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read",":tmpdir"="write",":slash_tmp"="write",glob_scan_max_depth=8,":workspace_roots"={"."="write","**/.env"="deny","**/.env.*"="deny","**/.codex"="deny","**/.codex/**"="deny","**/auth.json"="deny","**/.git-credentials"="deny","**/.netrc"="deny"}}`,
      `permissions.${CODEX_PERMISSION_PROFILE}.network={enabled=true,domains={"*"="allow"}}`,
    ],
  };
}

function configuredCodexModel(): string {
  return process.env.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL;
}

function configuredCodexReasoningEffort(): ReasoningEffort {
  const configured = process.env.CODEX_REASONING_EFFORT?.trim().toLowerCase();
  if (!configured) return DEFAULT_REASONING_EFFORT;
  if (!REASONING_EFFORTS.includes(configured as ReasoningEffort)) {
    throw new Error(
      `Invalid CODEX_REASONING_EFFORT: ${configured} (expected ${REASONING_EFFORTS.join(", ")})`,
    );
  }
  return configured as ReasoningEffort;
}

type McpServerRecord = Record<string, unknown> & { tools?: string[] };
type CachedCodexModel = {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
};

function isThreadNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(thread|session).*(not found|missing|unknown)/i.test(message);
}

function isCachedCodexModel(value: unknown): value is CachedCodexModel {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Session manager backed by the OpenAI Codex SDK. Each Provider method maps to
 * a Codex thread; features the SDK does not expose throw `UnsupportedError`.
 */
export class CodexProvider implements Provider {
  readonly name = "codex" as const;
  readonly displayName = "OpenAI Codex";

  private client: Codex;
  private sessions: Map<string, Thread> = new Map();
  private pending: Map<string, Promise<Thread>> = new Map();
  private sessionOperationQueues: Map<string, Promise<unknown>> = new Map();
  private messageQueues: Map<string, Promise<unknown>> = new Map();
  private store: SessionStore = new SessionStore(this.name);
  private histories: Map<string, HistoryEvent[]> = new Map();
  private workingDirOverrides: Map<string, string> = new Map();
  private modelOverrides: Map<string, string> = new Map();
  private reasoningEffortOverrides: Map<string, ReasoningEffort> = new Map();
  private mcpToolOverrides: Map<string, Record<string, string[]>> = new Map();

  constructor() {
    this.client = new Codex(codexClientOptions());
  }

  private threadOptions(key: string): ThreadOptions {
    const workingDirectory = this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory();
    const options: ThreadOptions = {
      model: this.modelOverrides.get(key) ?? configuredCodexModel(),
      modelReasoningEffort:
        this.reasoningEffortOverrides.get(key) ?? configuredCodexReasoningEffort(),
      workingDirectory,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      ...codexThreadSecurityOptions(),
    };
    return options;
  }

  private async getOrCreateSession(key: string): Promise<Thread> {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const storedThreadId = this.store.get(key);
    const creation = Promise.resolve(
      storedThreadId
        ? this.client.resumeThread(storedThreadId, this.threadOptions(key))
        : this.client.startThread(this.threadOptions(key))
    )
      .then((thread) => {
        if (this.pending.get(key) !== creation) return thread;
        this.sessions.set(key, thread);
        this.pending.delete(key);
        if (thread.id) this.store.set(key, thread.id);
        return thread;
      })
      .catch((err) => {
        if (this.pending.get(key) === creation) this.pending.delete(key);
        if (!storedThreadId) throw err;
        console.warn(
          `[CodexProvider] Resume failed for ${key} (${storedThreadId}), starting a new Codex thread:`,
          err
        );
        this.store.delete(key);
        const fresh = this.client.startThread(this.threadOptions(key));
        this.sessions.set(key, fresh);
        return fresh;
      });

    this.pending.set(key, creation);
    return creation;
  }

  private evictCachedSession(key: string, thread: Thread): void {
    if (this.sessions.get(key) === thread) this.sessions.delete(key);
  }

  private abandonTimedOutSession(key: string): void {
    this.sessions.delete(key);
    this.pending.delete(key);
    this.sessionOperationQueues.delete(key);
    this.store.delete(key);
  }

  private async withLiveSession<T>(
    key: string,
    operation: (thread: Thread) => Promise<T>
  ): Promise<T> {
    return this.enqueueSessionOperation(key, async () => {
      const thread = await this.getOrCreateSession(key);
      return this.runWithSessionRecovery(key, thread, operation);
    });
  }

  private async withExistingLiveSession<T>(
    key: string,
    operation: (thread: Thread) => Promise<T>
  ): Promise<T | null> {
    return this.enqueueSessionOperation(key, async () => {
      const thread = this.sessions.get(key);
      if (!thread) return null;
      return this.runWithSessionRecovery(key, thread, operation);
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
    thread: Thread,
    operation: (thread: Thread) => Promise<T>
  ): Promise<T> {
    try {
      return await operation(thread);
    } catch (err) {
      if (!isThreadNotFoundError(err)) throw err;

      console.warn(`[CodexProvider] Cached Codex thread for ${key} was not found; starting a new thread.`);
      this.evictCachedSession(key, thread);
      this.store.delete(key);
      const fresh = await this.getOrCreateSession(key);
      return operation(fresh);
    }
  }

  async sendMessage(
    userId: string,
    prompt: string,
    imagePaths?: SendAttachment[],
    options?: SendMessageOptions,
  ): Promise<string> {
    const tail = this.messageQueues.get(userId) ?? Promise.resolve();
    const next = tail.then(async () => {
      const images = imagePaths?.filter((attachment) => attachment.kind !== "file") ?? [];
      const files = imagePaths?.filter((attachment) => attachment.kind === "file") ?? [];
      const fileContext = await Promise.all(files.map(async (attachment) => {
        const text = await readFile(attachment.path, "utf8");
        return `[Discord attachment: ${attachment.displayName ?? "file"}]\n${text}\n[/Discord attachment]`;
      }));
      const resolvedPrompt = fileContext.length ? `${prompt}\n\n${fileContext.join("\n\n")}` : prompt;
      const input: string | UserInput[] =
        images.length > 0
          ? [
              { type: "text", text: resolvedPrompt },
              ...images.map((a) => ({ type: "local_image" as const, path: a.path })),
            ]
          : resolvedPrompt;

      this.appendHistory(userId, { type: "user.message", data: { content: prompt } });
      const timeoutMs = configuredMilliseconds("CODEX_TIMEOUT_MS", 60 * 60 * 1000);
      const controller = new AbortController();
      let timedOut = false;
      const stopProgress = startProgressUpdates(options);
      let abortGrace: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cancellationGraceMs = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5_000);
      let result;
      try {
        const run = this.withLiveSession(userId, (thread) =>
          thread.run(input, { signal: controller.signal })
        );
        const deadline = new Promise<never>((_resolve, reject) => {
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
      } catch (error) {
        if (timedOut && !(error instanceof RunTimeoutError)) {
          this.abandonTimedOutSession(userId);
          throw new RunTimeoutError(this.displayName, timeoutMs, true);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        clearTimeout(abortGrace);
        stopProgress();
      }

      if (result && this.sessions.get(userId)?.id) {
        this.store.set(userId, this.sessions.get(userId)!.id!);
      }

      const response =
        result.finalResponse || this.extractFinalResponse(result.items) || "(no response)";
      this.appendHistory(userId, { type: "assistant.message", data: { content: response } });
      return response;
    });

    this.messageQueues.set(userId, next.catch(() => {}));
    return next;
  }

  private appendHistory(key: string, event: HistoryEvent): void {
    const history = this.histories.get(key) ?? [];
    history.push(event);
    this.histories.set(key, history.slice(-100));
  }

  private extractFinalResponse(items: ThreadItem[]): string | null {
    const agentMessages = items
      .filter(
        (item): item is Extract<ThreadItem, { type: "agent_message" }> => item.type === "agent_message"
      )
      .map((item) => item.text)
      .filter(Boolean);
    return agentMessages.at(-1) ?? null;
  }

  async getStatus(): Promise<StatusInfo> {
    let version = "unknown";
    try {
      const pkg = require("@openai/codex/package.json") as { version?: string };
      version = pkg.version ? `@openai/codex ${pkg.version}` : version;
    } catch (err) {
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

  async getHistory(userId: string): Promise<HistoryEvent[] | null> {
    return this.withExistingLiveSession(userId, async () => this.histories.get(userId) ?? []);
  }

  async listModels(): Promise<ModelInfo[]> {
    const modelsById = new Map<string, ModelInfo>();
    for (const model of this.readCachedCodexModels()) {
      modelsById.set(model.id, model);
    }

    const configured = [configuredCodexModel(), ...this.modelOverrides.values()].filter(
      (model): model is string => Boolean(model)
    );
    for (const id of configured) {
      if (!modelsById.has(id)) modelsById.set(id, { id, name: id });
    }

    return Array.from(modelsById.values());
  }

  private readCachedCodexModels(): ModelInfo[] {
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const cachePath = path.join(codexHome, "models_cache.json");

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      return [];
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) {
      return [];
    }

    const models = (parsed as { models: unknown[] }).models
      .filter(isCachedCodexModel)
      .filter((model) => typeof model.slug === "string")
      .filter((model) => model.visibility !== "hide")
      .sort((a, b) => {
        const aPriority = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
        const bPriority = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
        return aPriority - bPriority;
      });

    return models.map((model) => {
      const id = model.slug as string;
      return {
        id,
        name: typeof model.display_name === "string" ? model.display_name : id,
      };
    });
  }

  async setModel(userId: string, model: string): Promise<void> {
    this.modelOverrides.set(userId, model);
    this.sessions.delete(userId);
  }

  async getCurrentModel(key: string): Promise<string | undefined> {
    return this.modelOverrides.get(key) ?? configuredCodexModel();
  }

  async listReasoningEfforts(): Promise<string[]> {
    return [...REASONING_EFFORTS];
  }

  async setReasoningEffort(key: string, effort: string): Promise<void> {
    const level = effort as ReasoningEffort;
    if (!REASONING_EFFORTS.includes(level)) {
      throw new Error(`Invalid reasoning effort: ${effort}.`);
    }
    this.reasoningEffortOverrides.set(key, level);
    this.sessions.delete(key);
  }

  async getCurrentReasoningEffort(key: string): Promise<string> {
    return this.reasoningEffortOverrides.get(key) ?? configuredCodexReasoningEffort();
  }

  async listAgents(): Promise<AgentInfo[]> {
    throw new UnsupportedError(this.displayName, "custom agent listing");
  }

  async getCurrentAgent(): Promise<AgentInfo | null> {
    throw new UnsupportedError(this.displayName, "custom agent selection");
  }

  async selectAgent(): Promise<AgentInfo> {
    throw new UnsupportedError(this.displayName, "custom agent selection");
  }

  async deselectAgent(): Promise<void> {
    throw new UnsupportedError(this.displayName, "custom agent selection");
  }

  async getMode(): Promise<SessionMode> {
    throw new UnsupportedError(this.displayName, "session mode switching");
  }

  async setMode(): Promise<void> {
    throw new UnsupportedError(this.displayName, "session mode switching");
  }

  async compact(): Promise<CompactResult> {
    throw new UnsupportedError(this.displayName, "history compaction");
  }

  async startFleet(): Promise<boolean> {
    throw new UnsupportedError(this.displayName, "fleet mode");
  }

  async readPlan(): Promise<PlanInfo> {
    throw new UnsupportedError(this.displayName, "plan management");
  }

  async updatePlan(): Promise<void> {
    throw new UnsupportedError(this.displayName, "plan management");
  }

  async deletePlan(): Promise<void> {
    throw new UnsupportedError(this.displayName, "plan management");
  }

  async listWorkspaceFiles(): Promise<string[]> {
    throw new UnsupportedError(this.displayName, "workspace file listing");
  }

  async readWorkspaceFile(): Promise<string> {
    throw new UnsupportedError(this.displayName, "workspace file reading");
  }

  async createWorkspaceFile(): Promise<void> {
    throw new UnsupportedError(this.displayName, "workspace file creation");
  }

  async resetSession(key: string): Promise<void> {
    this.sessions.delete(key);
    this.pending.delete(key);
    this.sessionOperationQueues.delete(key);
    this.messageQueues.delete(key);
    this.histories.delete(key);
    this.store.delete(key);
  }

  setSessionWorkingDir(key: string, dir: string): void {
    const canonical = resolveConfiguredWorkspace(dir);
    this.workingDirOverrides.set(key, canonical);
    this.sessions.delete(key);
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
      const skipped = !s.enabled;
      if (skipped) return { ...s, enabled: false, skipped: true };
      if (s.name in overrides) return { ...s, enabled: overrides[s.name].length > 0, skipped: false };
      return { ...s, skipped: false };
    });
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
    this.pending.clear();
    this.sessionOperationQueues.clear();
    this.messageQueues.clear();
  }
}
