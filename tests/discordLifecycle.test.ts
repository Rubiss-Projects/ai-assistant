import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordRuntime } from '../src/composition/discordLifecycle.js';
import { ConversationService, FileTurnJournal } from '../src/application/conversationService.js';
import { TEXT_CAPABILITIES } from '../src/core/conversation.js';

test('provider shutdown unblocks conversation and scheduler drains before ownership is released', { timeout: 2000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-drain-'));
  let finish!: () => void;
  let began!: () => void;
  const generating = new Promise<void>(resolve => { began = resolve; });
  const providerWork = new Promise<void>(resolve => { finish = resolve; });
  const service = new ConversationService(new FileTurnJournal(dir));
  const runtime = new DiscordRuntime({
    createSessions: () => ({ shutdown: async () => {
      assert.equal(existsSync(join(dir, 'owner.lock')), true);
      finish();
    } }),
    installConversations: () => service,
    createClient: () => ({ login: async () => {}, stopScheduler: () => providerWork, destroy: () => {} }),
    startReviews: () => {}, stopReviews: async () => {},
  });
  try {
    await runtime.start('fake');
    const turn = await service.submit({ eventId: 'e', sourceMessageId: 'e', text: 'work', receivedAt: new Date().toISOString(),
      actor: { platform: 'discord', tenantId: 'g', userId: 'u' },
      conversation: { platform: 'discord', tenantId: 'g', installationId: 'i', channelId: 'c', kind: 'channel' },
    }, { platform: 'discord', tenantId: 'g', installationId: 'i', audience: 'individual', capabilities: TEXT_CAPABILITIES,
      authorize: async () => true, prepare: async () => ({ prompt: 'work' }),
      generate: async () => { began(); await providerWork; return { content: 'late', attachments: [] }; },
      deliver: async () => { throw new Error('Cancelled generation must not deliver'); },
    });
    await generating;
    await runtime.stop();
    assert.equal((await turn.completion).state, 'cancelled');
    assert.equal(existsSync(join(dir, 'owner.lock')), false);
  } finally { finish(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('shared Discord journal rejects workspace paths and aliases before writing state', async t => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const { installDiscordConversations } = await import('../src/adapters/discord/turn.js');
  const dir = mkdtempSync(join(tmpdir(), 'discord-private-state-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const previous = { ...process.env };
  t.after(() => {
    for (const key of ['AI_ASSISTANT_SECURITY_MODE', 'AI_ASSISTANT_WORKSPACE_ROOT', 'AI_ASSISTANT_STATE_DIR']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.AI_ASSISTANT_SECURITY_MODE = 'shared';
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = workspace;
  const alias = join(dir, 'alias');
  symlinkSync(workspace, alias, 'dir');
  for (const state of [join(workspace, 'state'), join(alias, 'state')]) {
    process.env.AI_ASSISTANT_STATE_DIR = state;
    assert.throws(() => installDiscordConversations({} as never), /outside provider-readable/);
    assert.equal(existsSync(join(workspace, 'state')), false);
  }
  process.env.AI_ASSISTANT_STATE_DIR = join(dir, 'private-state');
  const service = installDiscordConversations({} as never);
  await service.shutdown();
});

for (const failure of ['client', 'login', 'reviews']) {
  test(`Discord ${failure} startup failure releases the journal for a successful restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-startup-'));
    const calls: string[] = [];
    const dependencies = {
      createSessions: () => ({ shutdown: async () => { calls.push('sessions'); } }),
      installConversations: () => new ConversationService(new FileTurnJournal(dir)),
      createClient: () => {
        if (failure === 'client') throw new Error('client failure');
        return { login: async () => { if (failure === 'login') throw new Error('login failure'); },
          stopScheduler: async () => { calls.push('scheduler'); }, destroy: () => { calls.push('client'); } };
      },
      startReviews: () => { if (failure === 'reviews') throw new Error('reviews failure'); },
      stopReviews: async () => { calls.push('reviews'); },
    };
    try {
      const failed = new DiscordRuntime(dependencies);
      await assert.rejects(failed.start('fake'), new RegExp(`${failure} failure`));
      assert.equal(existsSync(join(dir, 'owner.lock')), false);
      assert.ok(calls.includes('sessions'));
      const restarted = new DiscordRuntime({ ...dependencies,
        createClient: () => ({ login: async () => {}, stopScheduler: async () => {}, destroy: () => {} }),
        startReviews: () => {},
      });
      await restarted.start('fake');
      assert.equal(existsSync(join(dir, 'owner.lock')), true);
      await restarted.stop();
      assert.equal(existsSync(join(dir, 'owner.lock')), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('cleanup failures do not prevent journal release or provider shutdown; concurrent stops run once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-stop-'));
  let shutdowns = 0;
  const runtime = new DiscordRuntime({
    createSessions: () => ({ shutdown: async () => { shutdowns++; } }),
    installConversations: () => new ConversationService(new FileTurnJournal(dir)),
    createClient: () => ({ login: async () => {}, stopScheduler: async () => { throw new Error('scheduler'); }, destroy: () => { throw new Error('destroy'); } }),
    startReviews: () => {}, stopReviews: async () => { throw new Error('reviews'); },
  });
  try {
    await runtime.start('fake');
    const first = runtime.stop();
    assert.equal(first, runtime.stop());
    await assert.rejects(first, AggregateError);
    assert.equal(shutdowns, 1);
    assert.equal(existsSync(join(dir, 'owner.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shutdown while login is pending releases ownership and never starts reviews', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-login-stop-'));
  let finishLogin!: () => void;
  let reviews = false;
  const runtime = new DiscordRuntime({
    createSessions: () => ({ shutdown: async () => {} }),
    installConversations: () => new ConversationService(new FileTurnJournal(dir)),
    createClient: () => ({ login: () => new Promise<void>(resolve => { finishLogin = resolve; }), stopScheduler: async () => {}, destroy: () => {} }),
    startReviews: () => { reviews = true; }, stopReviews: async () => {},
  });
  try {
    const starting = runtime.start('fake');
    await runtime.stop();
    finishLogin();
    await assert.rejects(starting, /interrupted/);
    assert.equal(reviews, false);
    assert.equal(existsSync(join(dir, 'owner.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('journal recovery failure releases the newly acquired Discord ownership lock', async t => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { installDiscordConversations } = await import('../src/adapters/discord/turn.js');
  const dir = mkdtempSync(join(tmpdir(), 'discord-recovery-'));
  const previous = process.env.AI_ASSISTANT_STATE_DIR;
  process.env.AI_ASSISTANT_STATE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_ASSISTANT_STATE_DIR;
    else process.env.AI_ASSISTANT_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const journalDir = join(dir, 'discord-turns');
  mkdirSync(journalDir);
  const record = join(journalDir, 'a'.repeat(64) + '.json');
  writeFileSync(record, '{invalid');
  assert.throws(() => installDiscordConversations({} as never), SyntaxError);
  assert.equal(existsSync(join(journalDir, 'owner.lock')), false);
  rmSync(record);
  const service = installDiscordConversations({} as never);
  await service.shutdown();
});
