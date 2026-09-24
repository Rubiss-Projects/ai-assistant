import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotClient, CopilotSession, SessionConfigBase, SessionEvent } from "@github/copilot-sdk";
import { CopilotProvider } from "../src/providers/copilot.js";
import type { Thread } from "@openai/codex-sdk";
import { CodexProvider } from "../src/providers/codex.js";
import { openCodeChildEnvironment } from "../src/providers/opencode.js";
import { resolveSessionContext } from "../src/common/sessionContext.js";
import { SessionStore } from "../src/common/sessionStore.js";

test("Codex recovers a missing legacy handoff source without discarding ordinary failures", async t => {
  const directory = mkdtempSync(join(tmpdir(), "missing-handoff-"));
  const store = new SessionStore("test", join(directory, "sessions.json"));
  store.set("conversation", "missing-native-thread");
  let error = new Error("Provider temporarily unavailable");
  let starts = 0;
  const provider = new CodexProvider(() => ({
    resumeThread: id => {
      assert.equal(id, "missing-native-thread");
      return { run: async () => { throw error; } } as unknown as Thread;
    },
    startThread: () => {
      starts++;
      return { id: "replacement-thread", run: async () => ({ finalResponse: "Recovered", items: [] }) } as unknown as Thread;
    },
  }), store);
  provider.setSessionWorkingDir("conversation", directory);
  t.after(() => provider.shutdown());
  await assert.rejects(provider.sendMessage("conversation", "Continue"), /temporarily unavailable/);
  assert.equal(store.get("conversation"), "missing-native-thread");
  assert.equal(starts, 0);
  error = new Error("Thread not found: missing-native-thread");
  assert.equal((await provider.sendMessage("conversation", "Continue")).content, "Recovered");
  assert.equal(starts, 1);
  assert.equal(store.get("conversation"), "replacement-thread");
  assert.ok(store.getState("conversation")?.context);
});

test("Codex retains a saved handoff while replacing unreadable first-turn history", async t => {
  const directory = mkdtempSync(join(tmpdir(), "interrupted-handoff-"));
  const store = new SessionStore("test", join(directory, "sessions.json"));
  store.set("conversation", "interrupted-thread", resolveSessionContext().applied, "Historical PROJECT_ORCHID facts");
  const provider = new CodexProvider(() => ({
    resumeThread: () => ({ id: "interrupted-thread", runStreamed: async () => ({
      events: (async function* () {
        yield { type: "thread.started", thread_id: "interrupted-thread" };
        throw new Error("thread/resume failed: list_turns is not supported yet");
      })(),
    }) }) as unknown as Thread,
    startThread: () => ({ id: "recovered-thread", runStreamed: async (input: unknown) => ({
      events: (async function* () {
        assert.match(String(input), /PROJECT_ORCHID/);
        yield { type: "thread.started", thread_id: "recovered-thread" };
        assert.equal(store.get("conversation"), "recovered-thread");
        assert.match(store.getState("conversation")?.handoff ?? "", /PROJECT_ORCHID/);
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "Recovered" } };
        yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
      })(),
    }) }) as unknown as Thread,
  }), store);
  provider.setSessionWorkingDir("conversation", directory);
  t.after(() => provider.shutdown());
  assert.equal((await provider.sendMessage("conversation", "Retry")).content, "Recovered");
  assert.equal(store.get("conversation"), "recovered-thread");
  assert.equal(store.getState("conversation")?.handoff, undefined);
});

test("Copilot refreshes the same native session at dequeue time and fails closed on resume or persistence errors", async t => {
  const names = ["AI_ASSISTANT_SYSTEM_PROMPT", "AI_ASSISTANT_SYSTEM_PROMPT_FILE", "AI_ASSISTANT_SECURITY_MODE", "USER_INSTRUCTION_MODE"] as const;
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_ALPHA";
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  process.env.USER_INSTRUCTION_MODE = "admin_only";
  const directory = mkdtempSync(join(tmpdir(), "copilot-context-"));
  const store = new SessionStore("test", join(directory, "sessions.json"));
  const provider = new CopilotProvider();
  const internal = provider as unknown as { client: Pick<CopilotClient, "createSession" | "resumeSession" | "stop">; store: SessionStore };
  internal.store = store;
  provider.setSessionWorkingDir("conversation", directory);
  t.after(() => provider.shutdown());
  let disconnected = 0;
  let sends = 0;
  let failResume = false;
  const configs: SessionConfigBase[] = [];
  const resumed: string[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const session = (): CopilotSession => {
    let listener: (event: SessionEvent) => void = () => {};
    return {
      sessionId: "native-session",
      on: (handler: (event: SessionEvent) => void) => { listener = handler; return () => {}; },
      send: async () => {
        sends++;
        if (sends === 1) { firstStarted(); await firstPending; }
        listener({ type: "assistant.message", data: { content: "Ready." } } as SessionEvent);
        listener({ type: "session.idle", data: {} } as SessionEvent);
        return "message";
      },
      disconnect: async () => { disconnected++; },
    } as unknown as CopilotSession;
  };
  internal.client = {
    createSession: async config => { configs.push(config!); return session(); },
    resumeSession: async (id, config) => { resumed.push(id); if (failResume) throw new Error("Connection unavailable"); configs.push(config!); return session(); },
    stop: async () => [],
  };
  const first = provider.sendMessage("conversation", "First");
  await started;
  const second = provider.sendMessage("conversation", "Second");
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_BETA";
  process.env.USER_INSTRUCTION_MODE = "off";
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(configs.length, 2);
  assert.deepEqual(resumed, ["native-session"]);
  assert.equal(disconnected, 1);
  assert.match(JSON.stringify(configs[0].systemMessage), /POLICY_ALPHA/);
  assert.match(JSON.stringify(configs[1].systemMessage), /POLICY_BETA/);
  assert.doesNotMatch(JSON.stringify(configs[1].systemMessage), /POLICY_ALPHA/);
  assert.ok(configs[0].mcpServers?.ruleset_tools);
  assert.equal(configs[1].mcpServers?.ruleset_tools, undefined);
  await provider.sendMessage("conversation", "Unchanged");
  assert.equal(configs.length, 2);
  const applied = store.getState("conversation");
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_GAMMA";
  failResume = true;
  await assert.rejects(provider.sendMessage("conversation", "Must not run"), /Connection unavailable/);
  assert.deepEqual(store.getState("conversation"), applied);
  assert.equal(sends, 3);
  failResume = false;
  mkdirSync(join(directory, "sessions.json.tmp"));
  await assert.rejects(provider.sendMessage("conversation", "Must not run"));
  assert.deepEqual(store.getState("conversation"), applied);
  assert.equal(sends, 3);
});

test("OpenCode replaces native prompt and ruleset tools with the current snapshot on each invocation", t => {
  const names = ["AI_ASSISTANT_SYSTEM_PROMPT", "AI_ASSISTANT_SYSTEM_PROMPT_FILE", "USER_INSTRUCTION_MODE"] as const;
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_ALPHA";
  process.env.USER_INSTRUCTION_MODE = "admin_only";
  const bridge = { command: "node", args: ["bridge.js"], env: {} };
  const environment = () => {
    const context = resolveSessionContext();
    return openCodeChildEnvironment({ AI_ASSISTANT_SECURITY_MODE: "shared" }, bridge,
      context.rulesetsEnabled ? bridge : undefined, context.systemPrompt).OPENCODE_CONFIG_CONTENT;
  };
  const first = environment();
  assert.match(first, /POLICY_ALPHA/);
  assert.match(first, /ruleset_tools/);
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_BETA";
  process.env.USER_INSTRUCTION_MODE = "off";
  const second = environment();
  assert.match(second, /POLICY_BETA/);
  assert.doesNotMatch(second, /POLICY_ALPHA|ruleset_tools/);
});
