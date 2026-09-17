import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../src/sessionManager.js";

test("late preparation cannot create a provider once shutdown starts", async () => {
  // Exercise the facade with an injected provider, without starting a real SDK.
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(manager, {
    name: "codex", stopping: false, overrides: new Map(),
    providers: new Map([["codex", { shutdown: () => cleanup }]]),
  });
  const stopping = manager.shutdown();
  try {
    assert.throws(() => manager.sendMessage("thread", "late prepared request"), /shutting down/);
    await assert.rejects(manager.evaluateParticipation("thread", "{}"), /shutting down/);
    await assert.rejects(manager.runEphemeral("thread", "late enrichment"), /shutting down/);
    assert.equal((manager as any).providers.size, 0);
  } finally { finish(); await stopping; }
  assert.throws(() => manager.sendMessage("thread", "after cleanup"), /shutting down/);
});

test("shutdown during model lookup prevents starting a classifier", async () => {
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  let resolveModel!: (model: string) => void;
  const model = new Promise<string>(resolve => { resolveModel = resolve; });
  let evaluations = 0;
  Object.assign(manager, {
    name: "opencode", stopping: false, overrides: new Map(),
    providers: new Map([["opencode", {
      name: "opencode", getCurrentModel: () => model,
      evaluateParticipation: async () => { evaluations++; return '{}'; },
      shutdown: async () => {},
    }]]),
  });
  const previous = process.env.CHAT_PARTICIPATION_EVALUATOR;
  process.env.CHAT_PARTICIPATION_EVALUATOR = "provider";
  try {
    const evaluation = manager.evaluateParticipation("thread", "{}");
    await manager.shutdown();
    resolveModel("test/model");
    await assert.rejects(evaluation, /shutting down/);
    assert.equal(evaluations, 0);
  } finally {
    if (previous === undefined) delete process.env.CHAT_PARTICIPATION_EVALUATOR;
    else process.env.CHAT_PARTICIPATION_EVALUATOR = previous;
  }
});
