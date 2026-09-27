import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTurnJournal, ConversationService } from '../src/application/conversationService.js';
import type { TurnRecord } from '../src/core/conversation.js';

const moduleUrl = new URL('../src/application/conversationService.ts', import.meta.url).href;
const record: TurnRecord = {
  id: 'interrupted-turn', sessionKey: 'session', state: 'running', updatedAt: new Date().toISOString(),
  input: {
    eventId: 'event', sourceMessageId: 'event', text: 'work', receivedAt: new Date().toISOString(),
    actor: { platform: 'test', tenantId: 'tenant', userId: 'user' },
    conversation: { platform: 'test', tenantId: 'tenant', installationId: 'install', channelId: 'channel', kind: 'channel' },
  },
};

function worker(directory: string, crashBeforeMarker = false) {
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    if (${crashBeforeMarker}) {
      fs.linkSync = () => process.kill(process.pid, 'SIGKILL');
      syncBuiltinESMExports();
    }
    const { FileTurnJournal } = await import(${JSON.stringify(moduleUrl)});
    let journal;
    process.send('waiting');
    process.once('message', () => {
      try {
        journal = new FileTurnJournal(${JSON.stringify(directory)});
        journal.put(${JSON.stringify(record)});
        process.send('owned');
      } catch (error) { process.send(error.message); }
    });
    setInterval(() => journal?.get('interrupted-turn'), 1000);
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
}

async function message(child: ReturnType<typeof worker>) {
  const [value] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
  return value;
}

async function kill(child: ReturnType<typeof worker>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

test('a killed journal owner releases its lock and retained turns recover without replay', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-crash-'));
  const child = worker(directory);
  try {
    assert.equal(await message(child), 'waiting');
    const owned = message(child);
    child.send('acquire');
    assert.equal(await owned, 'owned');
    assert.throws(() => new FileTurnJournal(directory), /Another worker owns/);
    const marker = readFileSync(join(directory, 'owner.lock'), 'utf8');
    await kill(child);
    assert.equal(readFileSync(join(directory, 'owner.lock'), 'utf8'), marker);
    const journal = new FileTurnJournal(directory);
    const service = new ConversationService(journal);
    try {
      assert.equal(journal.get(record.id)?.state, 'interrupted');
      assert.deepEqual(service.pendingDeliveries(), []);
      assert.throws(() => new FileTurnJournal(directory), /Another worker owns/);
    } finally { await service.shutdown(); }
    assert.equal(existsSync(join(directory, 'owner.lock')), false);
    assert.equal(existsSync(join(directory, 'owner.sqlite')), true);
    new FileTurnJournal(directory).close();
  } finally { await kill(child); rmSync(directory, { recursive: true, force: true }); }
});

test('simultaneous processes admit exactly one journal owner', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-contenders-'));
  const children = [worker(directory), worker(directory)];
  try {
    assert.deepEqual(await Promise.all(children.map(message)), ['waiting', 'waiting']);
    const replies = children.map(message);
    for (const child of children) child.send('acquire');
    const results = await Promise.all(replies);
    assert.equal(results.filter(result => result === 'owned').length, 1);
    assert.match(String(results.find(result => result !== 'owned')), /Another worker owns/);
  } finally { await Promise.all(children.map(kill)); rmSync(directory, { recursive: true, force: true }); }
});

test('a crash before marker publication does not strand journal ownership', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-acquisition-crash-'));
  const child = worker(directory, true);
  try {
    assert.equal(await message(child), 'waiting');
    const closed = once(child, 'close');
    child.send('acquire');
    await closed;
    assert.equal(existsSync(join(directory, 'owner.lock')), false);
    assert.ok(readdirSync(directory).some(name => name.endsWith('.tmp')));
    new FileTurnJournal(directory).close();
  } finally { await kill(child); rmSync(directory, { recursive: true, force: true }); }
});

for (const marker of ['', '{partial', JSON.stringify({ pid: process.pid, started: new Date().toISOString() })]) {
  test('legacy or incomplete ownership is preserved for explicit migration: ' + JSON.stringify(marker), () => {
    const directory = mkdtempSync(join(tmpdir(), 'journal-legacy-'));
    try {
      writeFileSync(join(directory, 'owner.lock'), marker);
      assert.throws(() => new FileTurnJournal(directory), /Legacy or unrecognized/);
      assert.equal(readFileSync(join(directory, 'owner.lock'), 'utf8'), marker);
      rmSync(join(directory, 'owner.lock'));
      new FileTurnJournal(directory).close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
