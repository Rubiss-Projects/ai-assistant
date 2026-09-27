import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('committed distribution runs the CLI with native Node and no TypeScript loader', () => {
  const directory = mkdtempSync(join(tmpdir(), 'distribution-smoke-'));
  try {
    const result = spawnSync(process.execPath, ['dist/src/cli.js', 'cli', '--provider', 'fake', '--message', 'hello', '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, AI_ASSISTANT_STATE_DIR: directory, PROVIDER: 'fake' },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'delivered');
    assert.match(output.content, /hello/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const failure of ['provider', 'ownership', 'journal']) test('compiled CLI returns JSON for ' + failure + ' initialization failure', () => {
 const directory = mkdtempSync(join(tmpdir(), 'distribution-error-'));
 try {
  mkdirSync(join(directory, 'cli-turns'));
  if (failure === 'ownership') writeFileSync(join(directory, 'cli-turns', 'owner.lock'), 'another worker');
  if (failure === 'journal') writeFileSync(join(directory, 'cli-turns', 'a'.repeat(64) + '.json'), '{invalid');
  const result = spawnSync(process.execPath, ['dist/src/cli.js', 'cli', '--provider', failure === 'provider' ? 'invalid' : 'fake', '--message', 'hello', '--json'], {
   cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
   env: { ...process.env, AI_ASSISTANT_STATE_DIR: directory, PROVIDER: 'fake' },
  });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'failed');
  assert.equal(typeof output.error, 'string');
 } finally { rmSync(directory, { recursive: true, force: true }); }
});
