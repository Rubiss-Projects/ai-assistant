import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../scripts/container-entrypoint.sh', import.meta.url));
const registration = '/app/dist/scripts/register-commands.js';
const application = '/app/dist/src/index.js';
const shellOptions = { skip: process.platform === 'win32' ? 'Linux container entrypoint requires sh' : false };

function run(adapter?: string, flag?: string, args = ['start'], registrationStatus = '0', applicationStatus = '0') {
  const root = mkdtempSync(join(tmpdir(), 'container-entrypoint-'));
  try {
    const log = join(root, 'calls');
    const fakeNode = join(root, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$CALL_LOG"\n'
      + 'if [ "$1" = "/app/dist/scripts/register-commands.js" ]; then exit "$REGISTRATION_STATUS"; fi\n'
      + 'exit "$APPLICATION_STATUS"\n');
    chmodSync(fakeNode, 0o755);
    writeFileSync(log, '');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: root + delimiter + process.env.PATH,
      AI_ASSISTANT_WORKSPACE_ROOT: join(root, 'workspace'), CALL_LOG: log,
      REGISTRATION_STATUS: registrationStatus, APPLICATION_STATUS: applicationStatus };
    delete env.AI_ASSISTANT_ADAPTER;
    delete env.REGISTER_COMMANDS_ON_START;
    if (adapter !== undefined) env.AI_ASSISTANT_ADAPTER = adapter;
    if (flag !== undefined) env.REGISTER_COMMANDS_ON_START = flag;
    const result = spawnSync('sh', [entrypoint, ...args], { env, encoding: 'utf8' });
    assert.ifError(result.error);
    return { status: result.status, calls: readFileSync(log, 'utf8').trim().split('\n') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Discord registers by default and then starts the application', shellOptions, () => {
  for (const adapter of [undefined, '', '  ', 'discord', ' discord ']) {
    assert.deepEqual(run(adapter), { status: 0, calls: [registration, application] });
  }
});
test('Slack never registers Discord commands, even with registration enabled', shellOptions, () => {
  for (const flag of [undefined, '', 'true', 'false']) {
    for (const adapter of ['slack', ' slack ']) {
      assert.deepEqual(run(adapter, flag, ['start'], '42'), { status: 0, calls: [application] });
    }
  }
});
test('Discord honors disabled registration', shellOptions, () => {
  for (const flag of ['false', '0', 'TRUE']) {
    assert.deepEqual(run('discord', flag), { status: 0, calls: [application] });
  }
});
test('Discord registration failure prevents startup', shellOptions, () => {
  assert.deepEqual(run('discord', 'true', ['start'], '42'), { status: 42, calls: [registration] });
});
test('invalid adapters reach application validation without Discord registration', shellOptions, () => {
  assert.deepEqual(run('invalid', 'true'), { status: 0, calls: [application] });
});
test('custom commands bypass registration and preserve arguments and exit status', shellOptions, () => {
  assert.deepEqual(run('discord', 'true', ['node', 'custom.js', 'two words'], '0', '7'),
    { status: 7, calls: ['custom.js', 'two words'] });
});
test('application exit status is preserved', shellOptions, () => {
  assert.deepEqual(run('slack', undefined, ['start'], '0', '9'), { status: 9, calls: [application] });
});
test('Compose leaves the registration flag to the service env file', () => {
  const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /env_file:\s*\n\s*- \.env/);
  assert.doesNotMatch(compose, /^\s*REGISTER_COMMANDS_ON_START:/m);
});
