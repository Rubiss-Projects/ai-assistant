import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSlack } from '../src/adapters/slack.js';
import { FileTurnJournal } from '../src/application/conversationService.js';
import { eventKey, sessionKey, type IncomingTurn } from '../src/core/conversation.js';

function environment(directory: string) {
  return { AI_ASSISTANT_ADAPTER: 'slack', AI_ASSISTANT_SECURITY_MODE: 'shared',
    AI_ASSISTANT_STATE_DIR: directory, PROVIDER: 'fake', SLACK_BOT_TOKEN: 'test-bot', SLACK_APP_TOKEN: 'test-app',
    SLACK_TEAM_ID: 'T', SLACK_INSTALLATION_ID: 'i', SLACK_ALLOWED_CHANNELS: 'C', SLACK_ALLOWED_USERS: 'U' };
}

function configure(t: TestContext, directory: string) {
  const entries = Object.entries(environment(directory));
  const previous = entries.map(([key]) => [key, process.env[key]] as const);
  for (const [key, value] of entries) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
}

test('Slack startup replays generated output without a source retry and never repeats uncertain delivery', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'slack-replay-'));
  configure(t, directory);
  const input: IncomingTurn = { eventId: 'recovery', sourceMessageId: '1700000003.000000', text: 'question',
    receivedAt: new Date(1700000003000).toISOString(), actor: { platform: 'slack', tenantId: 'T', userId: 'U' },
    conversation: { platform: 'slack', tenantId: 'T', installationId: 'i', channelId: 'C', threadId: '1700000001.000000', kind: 'thread' } };
  const journalPath = join(directory, 'slack-turns');
  const journal = new FileTurnJournal(journalPath);
  const record = { id: eventKey(input), input, sessionKey: sessionKey(input, 'shared'), updatedAt: '',
    output: { content: 'already generated', attachments: [], audienceTag: createHash('sha256').update(JSON.stringify(['BOT', 'U'])).digest('hex') } };
  journal.put({ ...record, state: 'generated', retryGeneratedDelivery: true });
  const uncertain = { ...input, eventId: 'uncertain' };
  journal.put({ ...record, id: eventKey(uncertain), input: uncertain, state: 'delivering' });
  journal.close();
  let posts = 0;
  let controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const method = String(url).split('/').at(-1);
    if (method === 'auth.test') return Response.json({ ok: true, team_id: 'T', user_id: 'BOT' });
    if (method === 'conversations.info') return Response.json({ ok: true, channel: { is_member: true } });
    if (method === 'conversations.members') return Response.json({ ok: true, members: ['BOT', 'U'] });
    if (method === 'chat.postMessage') {
      posts++;
      assert.equal(new URLSearchParams(String(options?.body)).get('text'), 'already generated');
      return Response.json({ ok: true, ts: '1700000004.000000' });
    }
    if (method === 'apps.connections.open') {
      assert.equal(posts, 1, 'outbox must replay before accepting new Socket Mode events');
      controller.abort();
      throw controller.signal.reason;
    }
    throw new Error('Unexpected API call: ' + method);
  });
  await assert.rejects(startSlack(controller.signal), error => error === controller.signal.reason);
  assert.equal(existsSync(join(journalPath, 'owner.lock')), false);
  assert.deepEqual(readdirSync(join(directory, 'slack-provider-state')), [], 'recovery must not generate another provider response');
  controller = new AbortController();
  await assert.rejects(startSlack(controller.signal), error => error === controller.signal.reason);
  assert.equal(posts, 1);
  const restored = new FileTurnJournal(journalPath);
  try {
    assert.equal(restored.get(record.id)?.state, 'delivered');
    assert.equal(restored.get(record.id)?.output, undefined);
    assert.equal(restored.get(eventKey(uncertain))?.state, 'interrupted');
  } finally { restored.close(); }
});

for (const failure of ['journal', 'context']) test('Slack releases ownership after failed ' + failure + ' initialization', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'slack-startup-'));
  configure(t, directory);
  const journalPath = join(directory, 'slack-turns');
  mkdirSync(journalPath);
  if (failure === 'journal') writeFileSync(join(journalPath, 'a'.repeat(64) + '.json'), '{invalid');
  else writeFileSync(join(directory, 'slack-context'), 'blocks directory creation');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, team_id: 'T', user_id: 'BOT' }));
  await assert.rejects(startSlack());
  assert.equal(existsSync(join(journalPath, 'owner.lock')), false);
  const reopened = new FileTurnJournal(journalPath);
  reopened.close();
});

test('compiled Slack startup handles SIGTERM while Socket Mode connection is pending', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'slack-signal-'));
  const code = `
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/auth.test')) return Response.json({ok:true,team_id:'T',user_id:'BOT'});
      if (!String(url).endsWith('/apps.connections.open')) throw Error('unexpected request');
      return new Promise((resolve,reject) => {
        const keepAlive=setInterval(()=>{},1000);
        options.signal.addEventListener('abort',()=>{clearInterval(keepAlive);reject(options.signal.reason)},{once:true});
        console.error('WAITING_SOCKET');
      });
    };
    await import('./dist/src/index.js');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, ...environment(directory) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); });
  let stderr = '', sent = false;
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (!sent && stderr.includes('WAITING_SOCKET')) { sent = true; child.kill('SIGTERM'); }
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.ok(sent, stderr);
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(existsSync(join(directory, 'slack-turns', 'owner.lock')), false);
  const reopened = new FileTurnJournal(join(directory, 'slack-turns'));
  reopened.close();
});
