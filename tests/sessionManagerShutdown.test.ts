import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../src/sessionManager.js";
import { discordConversations, executeDiscordTurn } from "../src/adapters/discord/turn.js";
import type { Client } from 'discord.js';
import { createAccessPolicy } from '../src/common/accessPolicy.js';

for(const stage of ['execution','delivery']) test('Discord shutdown cancels a stalled ' + stage + ' authorization lookup', {timeout:2000}, async()=>{
  let began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve});
  let checks=0, generated=0;
  const client={guilds:{fetch:async()=>({members:{fetch:async()=>{
    if(++checks===(stage==='execution'?2:3)) {began();return new Promise<never>(()=>{});}
    return {roles:{cache:new Map()}};
  }}})}} as unknown as Client;
  const sessions={sendMessage:async()=>{generated++;return {content:'answer',attachments:[]}}} as unknown as SessionManager;
  const access=createAccessPolicy({DISCORD_ALLOWED_USERS:'user'});
  const turn=executeDiscordTurn(sessions,{id:'authorization-'+stage,guildId:'guild',channelId:'channel',author:{id:'user'},client},'session','hello',undefined,
    {rulesetContext:{access,requester:{userId:'user'}}},async()=>assert.fail('must not deliver'));
  const rejected=assert.rejects(turn);
  await started;
  await discordConversations(sessions).shutdown();
  await rejected;
  assert.equal(generated,stage==='execution'?0:1);
});

test('Discord shutdown aborts ephemeral preparation before provider shutdown', { timeout: 2000 }, async () => {
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let resets = 0, sends = 0;
  Object.assign(manager, {
    name: 'codex', stopping: false, shutdownController: new AbortController(), overrides: new Map(),
    providers: new Map([['codex', {
      sendMessage: (_key: string, _prompt: string, _files: unknown, options: { signal: AbortSignal }) => {
        sends++;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          began();
        });
      },
      resetSession: async () => { resets++; },
      shutdown: async () => {},
    }]]),
  });
  const turn = executeDiscordTurn(manager, { id: 'cancel-preparation', guildId: 'guild', channelId: 'channel', author: { id: 'user' } },
    'thread', 'search', undefined, {}, async () => assert.fail('must not deliver'),
    async (key, signal) => ({ prompt: await manager.runEphemeral(key, 'history inference', signal) }));
  const rejected = assert.rejects(turn);
  await started;
  await discordConversations(manager).shutdown();
  await rejected;
  assert.equal(sends, 1);
  assert.equal(resets, 1);
  await manager.shutdown();
});

test('shutdown aborts the signal of an active generation before provider cleanup', async () => {
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  let signal!: AbortSignal;
  Object.assign(manager, {
    name: 'codex', stopping: false, shutdownController: new AbortController(), overrides: new Map(),
    providers: new Map([['codex', {
      sendMessage: (_key: string, _prompt: string, _files: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      shutdown: async () => { assert.equal(signal.aborted, true); },
    }]]),
  });
  const controller = new AbortController();
  const result = assert.rejects(manager.sendMessage('thread', 'work', undefined, { signal: controller.signal }), /shutting down/);
  await manager.shutdown();
  await result;
  assert.equal(controller.signal.aborted, false);
});

test("late preparation cannot create a provider once shutdown starts", async () => {
  // Exercise the facade with an injected provider, without starting a real SDK.
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(manager, {
    name: "codex", stopping: false, shutdownController: new AbortController(), overrides: new Map(),
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
    name: "opencode", stopping: false, shutdownController: new AbortController(), overrides: new Map(),
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
