import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { RulesetTools, createRulesetToolRun, type RulesetToolContext } from "./rulesetTools.js";
import { RULESET_TOOLS } from "./rulesetToolDefinitions.js";
import type { SendMessageOptions } from "../providers/types.js";

export interface RulesetMcpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

class RulesetConnection {
  private readonly token = randomBytes(32).toString("hex");
  private readonly runs = new Map<string, RulesetTools>();
  private readonly server: Server;
  readonly ready: Promise<RulesetMcpConfig>;

  constructor() {
    this.server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/call" || request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(403).end(); return;
      }
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString();
          if (body.length > 32_768) { response.writeHead(413).end(); request.destroy(); return; }
        }
        const call = JSON.parse(body) as { name: string; arguments: Record<string, unknown> };
        const run = this.runs.get(String(call.arguments?.run_id));
        if (!run) throw new Error("Ruleset run is inactive or belongs to another session.");
        const result = await run.call(call.name, call.arguments);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }));
      } catch (error) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Ruleset operation failed." }] }));
      }
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.unref();
        const address = this.server.address();
        if (!address || typeof address === "string") { reject(new Error("Could not start ruleset bridge.")); return; }
        const development = import.meta.url.endsWith(".ts");
        const script = fileURLToPath(new URL(`../rulesetMcp.${development ? "ts" : "js"}`, import.meta.url));
        const args = development ? ["--import", createRequire(import.meta.url).resolve("tsx"), script] : [script];
        resolve({ command: process.execPath, args, env: {
          AI_RULESET_BRIDGE_URL: `http://127.0.0.1:${address.port}/call`, AI_RULESET_BRIDGE_TOKEN: this.token,
        } });
      });
    });
  }

  async run<T>(runtime: RulesetTools, action: (runtime: RulesetTools) => Promise<T>): Promise<T> {
    await this.ready;
    this.runs.set(runtime.id, runtime);
    try { return await action(runtime); }
    finally { this.runs.delete(runtime.id); await runtime.cancel(); }
  }

  async close(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.close()));
    this.runs.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export class RulesetToolSessions {
  private readonly connections = new Map<string, RulesetConnection>();
  private connection(key: string): RulesetConnection {
    let connection = this.connections.get(key);
    if (!connection) { connection = new RulesetConnection(); this.connections.set(key, connection); }
    return connection;
  }
  config(key: string): Promise<RulesetMcpConfig> { return this.connection(key).ready; }
  async run<T>(key: string, options: SendMessageOptions | undefined, action: (runtime: RulesetTools) => Promise<T>): Promise<T> {
    const run = createRulesetToolRun();
    const context: RulesetToolContext = {
      access: options?.rulesetContext?.access,
      requester: options?.rulesetContext?.requester,
      guildId: options?.rulesetContext?.guildId ?? options?.rulesetContext?.requester?.guildId ?? null,
    };
    const runtime = new RulesetTools(run, context);
    return this.connection(key).run(runtime, action);
  }
  async reset(key: string): Promise<void> {
    const connection = this.connections.get(key);
    this.connections.delete(key);
    await connection?.close();
  }
  async shutdown(): Promise<void> { await Promise.all([...this.connections.keys()].map((key) => this.reset(key))); }
}

export function rulesetToolPrompt(prompt: string, runtime: RulesetTools): string {
  return `${prompt}\n\n<ruleset-tools>The host exposes Discord user ruleset tools for this response. If an authorized admin asks you to add, update, delete, clear, enable, disable, list, get, or preview user-specific rules, call ruleset_tools with run_id ${JSON.stringify(runtime.id)}. Do not claim a ruleset was changed until the tool reports success.</ruleset-tools>`;
}

function rulesetMcpServerToml(config: RulesetMcpConfig): string {
  const env = Object.entries(config.env).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
  const tools = RULESET_TOOLS.map(({ name }) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(",");
  return `{command=${JSON.stringify(config.command)},args=${JSON.stringify(config.args)},env={${env}},tools={${tools}},startup_timeout_sec=60,tool_timeout_sec=120}`;
}

export function codexRulesetMcpOverride(config: RulesetMcpConfig, replaceAll = true): string {
  const server = rulesetMcpServerToml(config);
  return replaceAll ? `mcp_servers={ruleset_tools=${server}}` : `mcp_servers.ruleset_tools=${server}`;
}
