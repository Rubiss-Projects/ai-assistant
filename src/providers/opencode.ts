import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { SessionStore } from "../common/sessionStore.js";
import { UnsupportedError, type AgentInfo, type AuthStatus, type CompactResult, type HistoryEvent, type McpServerStatus, type ModelInfo, type PlanInfo, type Provider, type SendAttachment, type SessionMode, type StatusInfo } from "./types.js";

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

/**
 * Runs the `opencode` CLI non-interactively and returns its stdout.
 * Uses spawn (no shell) so prompts/arguments are never interpreted by a shell.
 */
function runOpenCode(
  args: string[],
  opts: { cwd?: string; timeoutMs: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(openCodeBin(), args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`opencode run timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
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
    return this.workingDirOverrides.get(key) ?? process.cwd();
  }

  async sendMessage(
    userId: string,
    prompt: string,
    imagePaths?: SendAttachment[]
  ): Promise<string> {
    const tail = this.messageQueues.get(userId) ?? Promise.resolve();
    const next = tail.then(async () => {
      const args = ["run", "--format", "json", "--auto"];
      const sessionId = this.sessions.get(userId) ?? this.store.get(userId);
      if (sessionId) args.push("--session", sessionId);
      const model = this.modelOverrides.get(userId) ?? this.configuredModel();
      if (model) args.push("--model", model);
      for (const img of imagePaths ?? []) {
        args.push("--file", img.path);
      }
      args.push(prompt);

      const timeoutMs = parseInt(process.env.OPENCODE_TIMEOUT_MS ?? "", 10) || 10 * 60 * 1000;
      this.appendHistory(userId, { type: "user.message", data: { content: prompt } });

      const { stdout, stderr, code } = await runOpenCode(args, {
        cwd: this.workingDir(userId),
        timeoutMs,
      });

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
      const res = await runOpenCode(["--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
      version = res.stdout.trim() || version;
    } catch (err) {
      console.warn("[OpenCodeProvider] Failed to read opencode version:", err);
    }

    let isAuthenticated = false;
    let login: string | undefined;
    try {
      const res = await runOpenCode(["auth", "list"], { cwd: process.cwd(), timeoutMs: 30_000 });
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
      const res = await runOpenCode(["models"], { cwd: process.cwd(), timeoutMs: 60_000 });
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
    if (!dir || dir.includes("\0")) {
      throw new Error("Invalid workspace path.");
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(path.resolve(dir));
    } catch {
      throw new Error(`Workspace path does not exist: ${path.resolve(dir)}`);
    }
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${canonical}`);
    }
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
