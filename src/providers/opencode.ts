import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { SessionStore } from "../common/sessionStore.js";
import { configuredSystemPrompt, withSystemPrompt } from "../common/systemPrompt.js";
import { configuredMilliseconds, startProgressUpdates } from "../common/runLifecycle.js";
import {
  configuredSecurityMode,
  ensureProviderWorkingDirectory,
  providerChildEnvironment,
  resolveConfiguredWorkspace,
  SENSITIVE_DIRECTORY_DENY_GLOBS,
  SENSITIVE_FILE_DENY_GLOBS,
  SENSITIVE_PATH_ALLOW_GLOBS,
  secureSystemPrompt,
} from "../common/providerSecurity.js";
import { RunTimeoutError, UnsupportedError, type AgentInfo, type AuthStatus, type CompactResult, type HistoryEvent, type McpServerStatus, type ModelInfo, type PlanInfo, type Provider, type SendAttachment, type SendMessageOptions, type SessionMode, type StatusInfo } from "./types.js";

/**
 * Resolves the `opencode` executable. Prefers OPENCODE_BIN, then well-known
 * npm-global install locations (Windows + POSIX), and finally falls back to the
 * bare command name so the OS PATH lookup is used (Linux/macOS installs).
 */
function resolveOpenCodeBinary(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;

  const binName = process.platform === "win32" ? "opencode.exe" : "opencode";
  const candidates: string[] = [];

  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(
      path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "opencode-ai",
        "bin",
        binName
      )
    );
  }
  if (process.env.HOME) {
    candidates.push(
      path.join(process.env.HOME, ".npm-global", "lib", "node_modules", "opencode-ai", "bin", binName)
    );
  }
  candidates.push(path.join("/usr", "local", "lib", "node_modules", "opencode-ai", "bin", binName));
  candidates.push(path.join("/usr", "lib", "node_modules", "opencode-ai", "bin", binName));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep trying
    }
  }
  return "opencode"; // rely on PATH lookup
}

function openCodeBin(): string {
  return resolveOpenCodeBinary();
}

/** Inline policy has the highest normal config precedence in OpenCode v1. */
export function openCodeSecurityConfig(): Record<string, unknown> {
  const sensitivePathPolicy = Object.fromEntries([
    ["*", "allow"],
    ...SENSITIVE_FILE_DENY_GLOBS.map((glob) => [glob, "deny"]),
    ...SENSITIVE_PATH_ALLOW_GLOBS.map((glob) => [glob, "allow"]),
    // OpenCode uses the last matching rule, so credential-directory denials must win.
    ...SENSITIVE_DIRECTORY_DENY_GLOBS.map((glob) => [glob, "deny"]),
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

export function openCodeChildEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
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

export function openCodeBaseRunArguments(
  source: Record<string, string | undefined> = process.env,
): string[] {
  return [
    "run",
    "--format",
    "json",
    ...(configuredSecurityMode(source) === "shared" ? ["--pure"] : []),
    "--auto",
  ];
}

export function openCodeRequestPrompt(prompt: string): string {
  return configuredSecurityMode() === "shared"
    ? `${secureSystemPrompt(configuredSystemPrompt())}\n\n${prompt}`
    : withSystemPrompt(prompt);
}

/**
 * Runs the `opencode` CLI non-interactively and returns its stdout.
 * Uses spawn (no shell) so prompts/arguments are never interpreted by a shell.
 */
function runOpenCode(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; providerName?: string }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
    let cancellationDeadline: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    let timedOut = false;
    let cancellationRequested = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancellationRequested = child.kill("SIGKILL");
      cancellationDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new RunTimeoutError(opts.providerName ?? "OpenCode", opts.timeoutMs, false));
      }, cancellationGraceMs);
    }, opts.timeoutMs);

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cancellationDeadline);
      reject(timedOut ? new RunTimeoutError(opts.providerName ?? "OpenCode", opts.timeoutMs, false) : err);
    });

    child.on("close", (code) => {
      if (settled) return;
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

interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: { type?: string; text?: string };
}

function parseEvents(stdout: string): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      try {
        events.push(JSON.parse(trimmed) as OpenCodeEvent);
      } catch {
        // Ignore non-JSON progress lines
      }
    }
  }
  return events;
}

function sessionIdFromEvents(events: OpenCodeEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].sessionID) return events[i].sessionID;
  }
  return undefined;
}

function finalTextFromEvents(events: OpenCodeEvent[]): string {
  const texts = events
    .filter((e) => e.type === "text" && typeof e.part?.text === "string")
    .map((e) => e.part!.text as string)
    .filter((t) => t.trim().length > 0);
  return texts.at(-1) ?? "";
}

/**
 * Session manager backed by the OpenCode CLI. Sessions are mapped 1:1 to
 * OpenCode session IDs (persisted via `SessionStore`) and continued with
 * `opencode run --session <id>`. Features the headless CLI does not expose for
 * this bot (plan/workspace/mode/fleet, etc.) throw `UnsupportedError`.
 */
export class OpenCodeProvider implements Provider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";

  private sessions: Map<string, string> = new Map(); // key -> opencode session id (live)
  private store: SessionStore = new SessionStore(this.name);
  private histories: Map<string, HistoryEvent[]> = new Map();
  private workingDirOverrides: Map<string, string> = new Map();
  private modelOverrides: Map<string, string> = new Map();
  private messageQueues: Map<string, Promise<unknown>> = new Map();

  private configuredModel(): string | undefined {
    return process.env.OPENCODE_MODEL?.trim() || undefined;
  }

  private workingDir(key: string): string {
    return this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory();
  }

  async sendMessage(
    userId: string,
    prompt: string,
    imagePaths?: SendAttachment[],
    options?: SendMessageOptions,
  ): Promise<string> {
    const tail = this.messageQueues.get(userId) ?? Promise.resolve();
    const next = tail.then(async () => {
      const args = openCodeBaseRunArguments();
      const sessionId = this.sessions.get(userId) ?? this.store.get(userId);
      if (sessionId) args.push("--session", sessionId);
      const model = this.modelOverrides.get(userId) ?? this.configuredModel();
      if (model) args.push("--model", model);
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

    this.messageQueues.set(userId, next.catch(() => {}));
    return next;
  }

  private appendHistory(key: string, event: HistoryEvent): void {
    const history = this.histories.get(key) ?? [];
    history.push(event);
    this.histories.set(key, history.slice(-100));
  }

  async getStatus(): Promise<StatusInfo> {
    let version = "unknown";
    try {
      const res = await runOpenCode(["--version"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 30_000 });
      version = res.stdout.trim() || version;
    } catch (err) {
      console.warn("[OpenCodeProvider] Failed to read opencode version:", err);
    }

    let isAuthenticated = false;
    let login: string | undefined;
    try {
      const res = await runOpenCode(["auth", "list"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 30_000 });
      isAuthenticated = res.code === 0;
      // Very loose: expose auth.json path as the login label.
      login = isAuthenticated ? "opencode auth (see ~/.local/share/opencode/auth.json)" : undefined;
    } catch (err) {
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

  async getHistory(userId: string): Promise<HistoryEvent[] | null> {
    if (!this.sessions.has(userId) && !this.store.get(userId)) return null;
    return this.histories.get(userId) ?? [];
  }

  async listModels(): Promise<ModelInfo[]> {
    let stdout = "";
    try {
      const res = await runOpenCode(["models"], { cwd: ensureProviderWorkingDirectory(), timeoutMs: 60_000 });
      stdout = res.stdout;
    } catch (err) {
      console.warn("[OpenCodeProvider] Failed to list models:", err);
    }
    const models: ModelInfo[] = [];
    for (const line of stdout.split("\n")) {
      const id = line.trim();
      if (id) models.push({ id, name: id });
    }
    return models;
  }

  async setModel(userId: string, model: string): Promise<void> {
    this.modelOverrides.set(userId, model);
    this.sessions.delete(userId);
  }

  async getCurrentModel(key: string): Promise<string | undefined> {
    return this.modelOverrides.get(key) ?? this.configuredModel();
  }

  // The remaining features require session/agent/bookkeeping the headless
  // `opencode run` flow does not expose for this bot.

  async listReasoningEfforts(): Promise<string[]> {
    throw new UnsupportedError(this.displayName, "reasoning effort control");
  }

  async setReasoningEffort(): Promise<void> {
    throw new UnsupportedError(this.displayName, "reasoning effort control");
  }

  async getCurrentReasoningEffort(): Promise<string> {
    throw new UnsupportedError(this.displayName, "reasoning effort control");
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
      } catch (err) {
        console.warn(`[OpenCodeProvider] Failed to delete opencode session ${sessionId}:`, err);
      }
    }
  }

  setSessionWorkingDir(key: string, dir: string): void {
    const canonical = resolveConfiguredWorkspace(dir);
    this.workingDirOverrides.set(key, canonical);
    this.sessions.delete(key);
  }

  getSessionWorkingDir(key: string): string | undefined {
    return this.workingDirOverrides.get(key);
  }

  setSessionMcpEnabled(): void {
    throw new UnsupportedError(this.displayName, "MCP server toggling");
  }

  getMcpStatus(): McpServerStatus[] {
    return [];
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
    this.messageQueues.clear();
  }
}
