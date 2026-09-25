import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SendMessageOptions } from "../providers/types.js";
import { githubContributionsEnabled, contributionReviewsEnabled } from "./githubContributionConfig.js";
import { githubContributionService, validateContributionChanges, type GitHubContributions } from "./githubContributions.js";
import { GITHUB_CONTRIBUTION_CALL_LIMITS, GITHUB_CONTRIBUTION_TIMEOUT_MS, githubContributionTools } from "./githubContributionToolDefinitions.js";
import { operationSignal } from "./operationSignal.js";

export interface GitHubContributionMcpConfig { command: string; args: string[]; env: Record<string, string> }
export class GitHubContributionRun {
  readonly id = randomUUID();
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly remaining: Record<keyof typeof GITHUB_CONTRIBUTION_CALL_LIMITS, number> = { ...GITHUB_CONTRIBUTION_CALL_LIMITS };
  constructor(private readonly session: string, private readonly options: SendMessageOptions | undefined, private readonly service: () => GitHubContributions = githubContributionService, private readonly timeoutMs = GITHUB_CONTRIBUTION_TIMEOUT_MS) {}
  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    // This budget includes queueing, token minting, and all sequential GitHub requests.
    const operation = operationSignal(this.controller.signal, this.timeoutMs, "GitHub contribution timed out. Check its status before retrying.");
    const action = Promise.resolve().then(async () => {
      operation.signal.throwIfAborted();
      const context = this.options?.rulesetContext;
      if (!githubContributionsEnabled() || (this.options?.contextProfile ?? "conversation") !== "conversation" || !context?.requester || !context.access
        || !context.access.can(context.requester, "github.contribute")) throw new Error("GitHub contribution access is unavailable for this requester or run.");
      if (args.run_id !== this.id) throw new Error("GitHub contribution run has expired or belongs to another session.");
      const tool = githubContributionTools().find(tool => tool.name === name);
      if (!tool || Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) throw new Error("Invalid contribution tool arguments.");
      const schema = tool.inputSchema;
      for (const key of schema.required) {
        if (key !== "changes" && (typeof args[key] !== "string" || (args[key] as string).length > 12_000)) throw new Error(`Invalid ${key}.`);
      }
      if (this.remaining[tool.name] === 0) throw new Error(`${tool.name} limit reached for this response. Stop calling this tool until the next user turn. Other tool budgets are independent. Remaining calls: ${JSON.stringify(this.remaining)}`);
      // Reserve synchronously before queueing work so parallel reads cannot spend publish/status calls.
      this.remaining[tool.name]--;
      const text = (key: string) => args[key] as string;
      const caller = { session: this.session, requester: context.requester, access: context.access, signal: operation.signal };
      const service = this.service();
      const result = await (() => {
        switch (tool.name) {
          case "github_contribution_begin": return service.begin(caller, text("repository"));
          case "github_contribution_read": return service.read(caller, text("contribution_id"), text("path"));
          case "github_contribution_status": return service.status(caller, text("contribution_id"));
          case "github_contribution_review": return service.review(caller, text("contribution_id"), text("expected_head_sha"));
          case "github_contribution_publish": return service.publish(caller, text("contribution_id"), text("expected_head_sha"), text("title"), text("body"), validateContributionChanges(args.changes));
          case "github_contribution_reviews": return service.reviews(caller, text("contribution_id"), args.after === undefined ? undefined : text("after"));
          case "github_contribution_reply_review": return service.replyReview(caller, text("contribution_id"), text("thread_id"), text("expected_head_sha"), text("expected_thread_version"), text("body"));
          case "github_contribution_resolve_review": return service.resolveReview(caller, text("contribution_id"), text("thread_id"), text("expected_head_sha"), text("expected_thread_version"));
        }
      })();
      return { ...result, remaining_calls: { ...this.remaining } };
    });
    this.pending.add(action);
    void action.finally(() => { operation.dispose(); this.pending.delete(action); }).catch(() => {});
    return action;
  }
  async cancel(): Promise<void> { this.controller.abort(); await Promise.allSettled(this.pending); }
}

class GitHubContributionConnection {
  private readonly token = randomBytes(32).toString("hex");
  private readonly runs = new Map<string, GitHubContributionRun>();
  private readonly server: Server;
  readonly ready: Promise<GitHubContributionMcpConfig>;
  constructor() {
    this.server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/call" || request.headers.authorization !== `Bearer ${this.token}`) { response.writeHead(403).end(); return; }
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          // One MB of text can expand sixfold as JSON escapes; also allow the bounded metadata.
          if (bytes > 6_500_000) { response.writeHead(413).end(); request.destroy(); return; }
          chunks.push(Buffer.from(chunk));
        }
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: string; arguments: Record<string, unknown> };
        if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error("Invalid contribution call.");
        const run = this.runs.get(String(call.arguments.run_id));
        if (!run) throw new Error("Contribution run is inactive or belongs to another session.");
        const result = await run.call(call.name, call.arguments);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }));
      } catch (error) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "GitHub contribution failed." }] }));
      }
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.unref();
        const address = this.server.address();
        if (!address || typeof address === "string") { reject(new Error("Could not start contribution bridge.")); return; }
        const development = import.meta.url.endsWith(".ts");
        const script = fileURLToPath(new URL(`../githubContributionMcp.${development ? "ts" : "js"}`, import.meta.url));
        const args = development ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, script] : [script];
        resolve({ command: process.execPath, args, env: { AI_GITHUB_BRIDGE_URL: `http://127.0.0.1:${address.port}/call`, AI_GITHUB_BRIDGE_TOKEN: this.token, AI_GITHUB_CODEX_REVIEWS: String(contributionReviewsEnabled()) } });
      });
    });
  }
  async run<T>(runtime: GitHubContributionRun, action: (run: GitHubContributionRun) => Promise<T>): Promise<T> {
    await this.ready;
    this.runs.set(runtime.id, runtime);
    try { return await action(runtime); }
    finally { this.runs.delete(runtime.id); await runtime.cancel(); }
  }
  async close(): Promise<void> {
    await Promise.all([...this.runs.values()].map(run => run.cancel()));
    this.runs.clear(); this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

export class GitHubContributionSessions {
  private readonly connections = new Map<string, GitHubContributionConnection>();
  constructor(private readonly service: () => GitHubContributions = githubContributionService) {}
  private connection(key: string): GitHubContributionConnection {
    let connection = this.connections.get(key);
    if (!connection) { connection = new GitHubContributionConnection(); this.connections.set(key, connection); }
    return connection;
  }
  config(key: string): Promise<GitHubContributionMcpConfig> { return this.connection(key).ready; }
  run<T>(key: string, options: SendMessageOptions | undefined, enabled: boolean, action: (run?: GitHubContributionRun) => Promise<T>): Promise<T> {
    if (!enabled) return action();
    return this.connection(key).run(new GitHubContributionRun(key, options, this.service), action);
  }
  async reset(key: string): Promise<void> { const connection = this.connections.get(key); this.connections.delete(key); await connection?.close(); }
  async shutdown(): Promise<void> { await Promise.all([...this.connections.keys()].map(key => this.reset(key))); }
}

export function githubContributionPrompt(prompt: string, run?: GitHubContributionRun): string {
  return run ? `${prompt}\n\n<github-contributions>Current run_id: ${JSON.stringify(run.id)}</github-contributions>` : prompt;
}
