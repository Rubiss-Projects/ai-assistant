import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { withOpenCodeServer } from "../src/providers/openCodeServer.js";
import { assertOpenCodeV2, openCodeBaseRunArguments, openCodeChildEnvironment, openCodeIsolatedEnvironment } from "../src/providers/opencode.js";

// Exercise the installed CLI and its actual config/NDJSON contracts without
// credentials, paid inference, or Discord. The model endpoint is a local fixture.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-smoke-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, ".env"), "SMOKE_SECRET_LEAK");
fs.writeFileSync(path.join(workspace, ".env.example"), "SMOKE_ALLOWED_FILE");
fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({
  plugins: ["./must-not-load"], permissions: [{ action: "shell", resource: "*", effect: "allow" }],
  agents: { smoke: { system: "UNTRUSTED_PROJECT_PROMPT" } },
}));
const bridge = path.join(root, "bridge.mjs");
fs.writeFileSync(bridge, `
import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool("probe", { description: "Return the fixture marker" }, () => ({ content: [{ type: "text", text: process.env.SMOKE_BRIDGE_VALUE }] }));
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void server.close(); });
`);
let requests = 0;
let bridgeObserved = false;
const model = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  assert.match(req.url ?? "", /chat\/completions$/);
  const input = JSON.parse(body) as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
  assert.match(JSON.stringify(input.messages), /SMOKE_SYSTEM_PROMPT/);
  assert.doesNotMatch(JSON.stringify(input.messages), /UNTRUSTED_PROJECT_PROMPT/);
  const tools = input.tools?.map(tool => tool.function.name) ?? [];
  assert.ok(!tools.includes("shell"));
  assert.ok(!tools.includes("subagent"));
  assert.ok(tools.includes("artifact_tools_probe"), `Missing host MCP tool: ${tools.join(", ")}`);
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const needsTool = !input.messages.some(message => message.role === "tool");
  if (!needsTool) {
    assert.match(JSON.stringify(input.messages), /MCP_BRIDGE_OK/);
    assert.match(JSON.stringify(input.messages), /SMOKE_ALLOWED_FILE/);
    assert.doesNotMatch(JSON.stringify(input.messages), /SMOKE_SECRET_LEAK/);
    bridgeObserved = true;
  }
  const calls = [
    { name: "artifact_tools_probe", arguments: "{}" },
    { name: "read", arguments: JSON.stringify({ path: ".env" }) },
    { name: "read", arguments: JSON.stringify({ path: ".env.example" }) },
  ];
  const delta = needsTool ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `fixture-${index}`, type: "function", function: call })) } : { role: "assistant", content: "OPENCODE_V2_OK" };
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: needsTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
assert.ok(address && typeof address !== "string");
const env = openCodeIsolatedEnvironment(openCodeChildEnvironment({
  PATH: process.env.PATH,
  AI_ASSISTANT_SECURITY_MODE: "shared",
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
}, { command: process.execPath, args: [bridge], env: { SMOKE_BRIDGE_VALUE: "MCP_BRIDGE_OK" } }, undefined, "SMOKE_SYSTEM_PROMPT", "smoke"), path.join(root, "home"));
env.OPENCODE_DISABLE_MODELS_FETCH = "1";
const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
config.providers = {
  fixture: {
    package: "aisdk:@ai-sdk/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" },
    models: { fixture: { name: "Fixture", limit: { context: 8192, output: 512 } } },
  },
};
env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

function cli(args: string[], stdin?: string, environment: NodeJS.ProcessEnv = env, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OPENCODE_BIN || "opencode", args, { cwd: workspace, env: environment, signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`OpenCode ${args[0]} failed (${code}): ${stderr}\n${stdout}`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

try {
  assertOpenCodeV2(await cli(["--version"]));
  assert.match(await cli(["models", "--standalone"]), /fixture\/fixture/);
  assert.deepEqual(JSON.parse(await cli(["auth", "list", "--format", "json", "--standalone"])), []);
  const run = async (session?: string) => {
    const stdout = await withOpenCodeServer(process.env.OPENCODE_BIN || "opencode", { cwd: workspace, env, timeoutMs: 60_000, mcpServers: ["artifact_tools"] },
      (url, environment, signal) => cli([...openCodeBaseRunArguments(), "--server", url, "--agent", "smoke", "--title", "Fixture", "--model", "fixture/fixture", ...(session ? ["--session", session] : []), "fixture request"], undefined, environment, signal));
    const events = stdout.trim().split("\n").map(line => JSON.parse(line) as { type: string; sessionID: string; part?: { text?: string } });
    assert.equal(events.filter(event => event.type === "text").at(-1)?.part?.text, "OPENCODE_V2_OK");
    const id = events.find(event => event.sessionID)?.sessionID;
    assert.ok(id);
    return id;
  };
  const session = await run();
  assert.equal(await run(session), session);
  await cli(["auth", "import", "--standalone"], await cli(["auth", "export", "--standalone"]));
  await cli(["session", "delete", session, "--standalone"]);
  assert.ok(bridgeObserved);
  assert.equal(requests, 3);
  console.log("OpenCode V2: native config, model discovery, auth transfer, prompt, JSON output, session resume/delete, host MCP execution, and project isolation verified.");
} finally {
  await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
