import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWithJev, participationEvaluatorConfig } from "../src/common/participationEvaluator.js";
import { runParticipationProcess } from "../src/providers/participationProcess.js";
import { CopilotProvider } from "../src/providers/copilot.js";
import { selectOpenCodeParticipationModel } from "../src/providers/opencode.js";
import { CodexProvider } from "../src/providers/codex.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = participationEvaluatorConfig({});
const prompt = JSON.stringify({ candidateIds: ["1", "2"], cooldown: false, messages: [] });
function response(answers: unknown) { return async () => new Response(JSON.stringify({ answers }), { status: 200 }); }

test("evaluator settings default to provider and reject invalid configuration", () => {
  assert.equal(config.evaluator, "provider");
  assert.equal(config.effort, "none");
  assert.throws(() => participationEvaluatorConfig({ CHAT_PARTICIPATION_EVALUATOR: "jev" }), /TYPESAFE_API_KEY/);
  assert.throws(() => participationEvaluatorConfig({ CHAT_PARTICIPATION_EVALUATOR: "unknown" }));
  assert.throws(() => participationEvaluatorConfig({ CHAT_PARTICIPATION_TIMEOUT_MS: "NaN" }));
  assert.throws(() => participationEvaluatorConfig({ CHAT_PARTICIPATION_JEV_THRESHOLD: "0.1" }));
});

test("Jev uses documented typed choices and selects a confident direct request", async () => {
  let body: Record<string, any> = {};
  const result = await evaluateWithJev(prompt, config, "synthetic-test-key", async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(options?.redirect, "error");
    body = JSON.parse(String(options?.body));
    assert.equal(body.model, "jev-latest");
    assert.equal(body.questions.message_0.type, "choice");
    return response({
      message_0: { type: "choice", choice: "reaction_0", probabilities: { reaction_0: 0.95 } },
      message_1: { type: "choice", choice: "direct_reply", probabilities: { direct_reply: 0.9 } },
    })();
  });
  assert.deepEqual(JSON.parse(result), { action: "reply", messageId: "2", directed: true });
});

test("Jev stays silent on uncertain, missing, or unexpected answers", async () => {
  for (const answer of [
    { type: "choice", choice: "direct_reply", probabilities: { direct_reply: 0.7 } },
    { type: "choice", choice: "direct_reply", confidence: 0.99 },
    { type: "choice", choice: "reaction_99", probabilities: { reaction_99: 1 } },
    { type: "choice", choice: "direct_reply", probabilities: { direct_reply: 2 } },
    { type: "choice", choice: "direct_reply", probabilities: { direct_reply: "0.95" } },
    null,
  ]) {
    assert.deepEqual(JSON.parse(await evaluateWithJev(prompt, config, "test", response({ message_0: answer }) as typeof fetch)), { action: "ignore" });
  }
});

test("Jev combines reply alternatives without treating ambiguous audience as directed", async () => {
  const result = await evaluateWithJev(prompt, config, "test", response({ message_0: {
    type: "choice", choice: "unsolicited_reply", probabilities: { direct_reply: 0.28, unsolicited_reply: 0.64, ignore: 0.08 },
  } }) as typeof fetch);
  assert.deepEqual(JSON.parse(result), { action: "reply", messageId: "1", directed: false });
});

test("Jev returns only allowlisted emoji and does not expose error response bodies", async () => {
  assert.deepEqual(JSON.parse(await evaluateWithJev(prompt, config, "test", response({
    message_0: { type: "choice", choice: "reaction_2", probabilities: { reaction_2: 0.9 } },
  }) as typeof fetch)), { action: "react", messageId: "1", emoji: "🎉" });
  await assert.rejects(evaluateWithJev(prompt, config, "test", (async () => new Response("secret response body", { status: 401 })) as typeof fetch), /^Error: TypeSafe participation request failed \(401\)\.$/);
});

test("classification process enforces timeout and passes prompt as data", async () => {
  await assert.rejects(runParticipationProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
    cwd: tmpdir(), env: process.env, timeoutMs: 50,
  }), /timed out/);
  const text = 'literal $(touch should-not-exist) `commands`';
  const output = await runParticipationProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    cwd: tmpdir(), env: process.env, timeoutMs: 2000, stdin: text,
  });
  assert.equal(output, text);
});

test("Copilot classifier disables tools/discovery and removes its temporary session", async () => {
  const provider = new CopilotProvider();
  let removed = false;
  let listener: (event: any) => void;
  const session = {
    sessionId: "classifier", disconnect: async () => {},
    on: (handler: (event: any) => void) => { listener = handler; return () => {}; },
    send: async () => { listener({ type: "assistant.message", data: { content: '{"action":"ignore"}' } }); listener({ type: "session.idle" }); },
  };
  (provider as any).client = {
    createSession: async (options: any) => {
      assert.deepEqual(options.availableTools, []);
      assert.deepEqual(options.excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
      assert.equal(options.enableConfigDiscovery, false);
      assert.equal(options.skipCustomInstructions, true);
      assert.deepEqual(options.mcpServers, {});
      assert.equal(options.model, "gpt-5.6-luna");
      assert.equal(options.onPermissionRequest({}).kind, "reject");
      return session;
    },
    deleteSession: async () => { removed = true; },
  };
  assert.equal(await provider.evaluateParticipation("synthetic", { timeoutMs: 100, effort: "none" }), '{"action":"ignore"}');
  assert.equal(removed, true);
});

test("Codex classifier runs independently with restricted settings and existing login", async t => {
  const directory = mkdtempSync(join(tmpdir(), "classifier-test-"));
  const binary = join(directory, "codex-test.cjs");
  const old = process.env.CODEX_EXECUTABLE_PATH;
  t.after(() => {
    if (old === undefined) delete process.env.CODEX_EXECUTABLE_PATH; else process.env.CODEX_EXECUTABLE_PATH = old;
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(binary, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
for (const flag of ['--ephemeral','--ignore-user-config','--ignore-rules','read-only','features.shell_tool=false','features.apps=false','mcp_servers={}']) assert.ok(args.includes(flag), flag);
assert.ok(!args.includes('--session'));
let input = ''; process.stdin.on('data', x => input += x); process.stdin.on('end', () => {
assert.equal(input, 'synthetic classification');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"action":"ignore"}'}}));
});
`, { mode: 0o700 });
  process.env.CODEX_EXECUTABLE_PATH = binary;
  const provider = new CodexProvider();
  assert.equal(await provider.evaluateParticipation("synthetic classification", { timeoutMs: 2000, effort: "none" }), '{"action":"ignore"}');
});

test("OpenCode keeps the configured connection and chooses an available small model", () => {
  const models = ["openrouter/openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5"];
  assert.equal(selectOpenCodeParticipationModel(models), "openrouter/openai/gpt-5.6-luna");
  assert.equal(selectOpenCodeParticipationModel(models, "anthropic/claude-sonnet-5"), "anthropic/claude-haiku-4.5");
  assert.equal(selectOpenCodeParticipationModel(models, "custom/local-model"), "custom/local-model");
  assert.throws(() => selectOpenCodeParticipationModel([]), /CHAT_PARTICIPATION_MODEL/);
});

test("Copilot startup timeout cleans up a late classification session", async () => {
  const provider = new CopilotProvider();
  let resolve!: (session: unknown) => void;
  let removed = false;
  (provider as any).client = {
    createSession: () => new Promise(done => { resolve = done; }),
    deleteSession: async () => { removed = true; },
  };
  await assert.rejects(provider.evaluateParticipation("synthetic", { timeoutMs: 10, effort: "none" }), /startup/);
  resolve({ sessionId: "late", disconnect: async () => {} });
  await new Promise(done => setImmediate(done));
  assert.equal(removed, true);
});
