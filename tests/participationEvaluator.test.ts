import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWithJev, participationEvaluatorConfig } from "../src/common/participationEvaluator.js";
import { ParticipationProcessRunner, runParticipationProcess } from "../src/providers/participationProcess.js";
import { CopilotProvider } from "../src/providers/copilot.js";
import { selectOpenCodeParticipationModel } from "../src/providers/opencode.js";
import { CodexProvider } from "../src/providers/codex.js";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = participationEvaluatorConfig({});
const prompt = JSON.stringify({ candidateIds: ["1", "2"], cooldown: false, messages: [] });
function choiceAnswer(choice: string, scores: Record<string, number>) {
  const probabilities = { ignore: 0, direct_reply: 0, unsolicited_reply: 0, react: 0, ...scores };
  if (!("ignore" in scores)) probabilities.ignore = 1 - Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  return { type: "choice", choice, probabilities };
}
function response(answers: unknown) { return async () => new Response(JSON.stringify({ answers }), { status: 200 }); }

test("evaluator settings default to provider and reject invalid configuration", () => {
  assert.equal(config.evaluator, "provider");
  assert.equal(config.effort, "none");
  assert.throws(() => participationEvaluatorConfig({ CHAT_PARTICIPATION_EVALUATOR: "jev" }), /TYPESAFE_API_KEY/);
  assert.throws(() => participationEvaluatorConfig({ CHAT_PARTICIPATION_EVALUATOR: "unknown" }));
  assert.throws(() => participationEvaluatorConfig({ CHAT_PARTICIPATION_TIMEOUT_MS: "NaN" }));
  assert.deepEqual(participationEvaluatorConfig({ CHAT_PARTICIPATION_JEV_THRESHOLD: "0.99" }), config);
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
      message_0: choiceAnswer("react", { react: 0.95 }),
      message_1: choiceAnswer("direct_reply", { direct_reply: 0.9 }),
    })();
  });
  assert.deepEqual(JSON.parse(result), { action: "reply", messageId: "2", directed: true });
});

test("Jev reports malformed distributions instead of disguising them as silence", async () => {
  for (const answer of [
    { type: "choice", choice: "direct_reply", probabilities: { direct_reply: 0.69 } },
    { type: "choice", choice: "direct_reply", confidence: 0.99 },
    { type: "choice", choice: "reaction_99", probabilities: { reaction_99: 1 } },
    { type: "choice", choice: "direct_reply", probabilities: { direct_reply: 2 } },
    { type: "choice", choice: "direct_reply", probabilities: { direct_reply: "0.95" } },
    choiceAnswer("direct_reply", { direct_reply: 0.2, ignore: 0.8 }),
    choiceAnswer("direct_reply", { direct_reply: 0.8, ignore: 0.8 }),
    choiceAnswer("direct_reply", { direct_reply: 0.2, ignore: 0.1 }),
    choiceAnswer("direct_reply", { direct_reply: 0, ignore: 0 }),
    choiceAnswer("direct_reply", { direct_reply: 0.8, unexpected: 0.2 }),
    { ...choiceAnswer("direct_reply", { direct_reply: 1 }), probabilities: [] },
    null,
  ]) {
    await assert.rejects(evaluateWithJev(prompt, config, "test", response({ message_0: answer }) as typeof fetch), /Invalid TypeSafe/);
  }
});

for (const [name, choice, scores, expected] of [
  ["direct reply wins below old cutoff", "direct_reply", { direct_reply: 0.6, ignore: 0.25, unsolicited_reply: 0.05, react: 0.1 }, { action: "reply", messageId: "1", directed: true }],
  ["unsolicited reply wins below old cutoff", "unsolicited_reply", { direct_reply: 0.2, unsolicited_reply: 0.45, ignore: 0.35 }, { action: "reply", messageId: "1", directed: false }],
  ["ignore beats each reply even when their sum wins", "ignore", { ignore: 0.4, direct_reply: 0.35, unsolicited_reply: 0.25 }, { action: "ignore" }],
  ["reaction selection is independent of emoji ambiguity", "react", { react: 0.55, direct_reply: 0.35, ignore: 0.1 }, { action: "react", messageId: "1", emoji: "❤️" }],
  ["flat distribution uses Jev's selected tie", "direct_reply", { ignore: 0.25, direct_reply: 0.25, unsolicited_reply: 0.25, react: 0.25 }, { action: "reply", messageId: "1", directed: true }],
] as const) {
  test(`Jev ranking: ${name}`, async () => {
    const result = await evaluateWithJev(prompt, config, "test", response({
      message_0: choiceAnswer(choice, scores), message_1: choiceAnswer("ignore", { ignore: 1 }),
      emoji_0: { type: "choice", choice: "emoji_1", probabilities: { emoji_0: 0.45, emoji_1: 0.55, emoji_2: 0, emoji_3: 0, emoji_4: 0 } },
    }) as typeof fetch);
    assert.deepEqual(JSON.parse(result), expected);
  });
}

test("custom emoji are batched with actions and mapped back to host values", async () => {
  const state = { candidateIds: ["1"], messages: [], availableEmojis: [{ value: "👍", name: "thumbs up" }, { value: "123456789012345678", name: "party_parrot" }] };
  let calls = 0;
  const result = await evaluateWithJev(JSON.stringify(state), config, "test", async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.state, state);
    assert.deepEqual(Object.keys(body.questions.message_0.criteria), ["ignore", "direct_reply", "unsolicited_reply", "react"]);
    assert.deepEqual(body.questions.emoji_0.criteria, { emoji_0: "thumbs up", emoji_1: "party_parrot" });
    assert.match(body.questions.emoji_0.instructions, /Assuming.*candidate message "1"/);
    return response({ message_0: choiceAnswer("react", { react: 1 }), emoji_0: { type: "choice", choice: "emoji_1", probabilities: { emoji_0: 0.2, emoji_1: 0.8 } } })();
  });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(result), { action: "react", messageId: "1", emoji: "123456789012345678" });
});

test("only the selected reaction requires a valid speculative emoji answer", async () => {
  await assert.rejects(evaluateWithJev(prompt, config, "test", response({
    message_0: choiceAnswer("react", { react: 1 }), message_1: choiceAnswer("ignore", { ignore: 1 }),
  }) as typeof fetch), /Invalid TypeSafe emoji/);
  const result = await evaluateWithJev(prompt, config, "test", response({
    message_0: choiceAnswer("react", { react: 1 }), message_1: choiceAnswer("direct_reply", { direct_reply: 1 }),
    emoji_0: { type: "choice", choice: "invented" },
  }) as typeof fetch);
  assert.deepEqual(JSON.parse(result), { action: "reply", messageId: "2", directed: true });
});

test("Jev does not expose service error response bodies", async () => {
  await assert.rejects(evaluateWithJev(prompt, config, "test", (async () => new Response("secret response body", { status: 401 })) as typeof fetch), /^Error: TypeSafe participation request failed \(401\).$/);
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

test("classifier shutdown kills active children and rejects subsequent discovery or requests", async () => {
  const runner = new ParticipationProcessRunner();
  const directory = mkdtempSync(join(tmpdir(), "classifier-shutdown-"));
  const marker = join(directory, "pid");
  const options = { cwd: directory, env: process.env, timeoutMs: 60_000 };
  const running = runner.run(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", marker], options);
  const rejected = assert.rejects(running, /stopped/);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), "child started");
    const pid = Number(readFileSync(marker, "utf8"));
    await runner.shutdown();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(runner.run(process.execPath, ["-e", "process.exit(0)"], options), /stopped/);
  } finally {
    await runner.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
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

test("large catalogs split bounded requests without dropping emoji or losing priority", async () => {
  const candidateIds = Array.from({ length: 12 }, (_, i) => String(i));
  const availableEmojis = Array.from({ length: 300 }, (_, i) => ({ value: String(1000 + i), name: `server_celebration_${i}` }));
  let calls = 0;
  let signal: AbortSignal | undefined;
  const result = await evaluateWithJev(JSON.stringify({ candidateIds, availableEmojis, messages: [] }), config, "test", async (_url, options) => {
    calls++;
    assert.ok(Buffer.byteLength(String(options?.body)) <= 60_000);
    if (signal) assert.equal(options?.signal, signal);
    signal = options?.signal as AbortSignal;
    const body = JSON.parse(String(options?.body));
    assert.equal(body.state.availableEmojis.length, 300);
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(body.questions).filter(key => key.startsWith("message_"))) {
      const index = key.slice("message_".length);
      assert.equal(Object.keys(body.questions[`emoji_${index}`].criteria).length, 300);
      answers[key] = choiceAnswer("direct_reply", { direct_reply: 1 });
    }
    return response(answers)();
  });
  assert.ok(calls > 1);
  assert.deepEqual(JSON.parse(result), { action: "reply", messageId: "11", directed: true });
});
