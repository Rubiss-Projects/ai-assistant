import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertOpenCodeV2, openCodeIsolatedEnvironment, OpenCodeProvider } from "../src/providers/opencode.js";
import { withOpenCodeServer } from "../src/providers/openCodeServer.js";
import { SessionStore } from "../src/common/sessionStore.js";

test("OpenCode requires V2 and isolates config without losing the persistent data path", () => {
  for (const version of ["opencode v2.0.31\n", "2.0.31", "2.1.0-beta.1"]) assert.doesNotThrow(() => assertOpenCodeV2(version));
  for (const version of ["1.19.3", "2.0.24", "unknown", "3.0.0"]) assert.throws(() => assertOpenCodeV2(version), /V2 .*is required/);
  const env = openCodeIsolatedEnvironment({ HOME: "/operator", XDG_DATA_HOME: "/persistent", OPENCODE_CONFIG_DIR: "/ambient" }, "/private");
  assert.equal(env.XDG_DATA_HOME, "/persistent");
  assert.equal(env.OPENCODE_CONFIG_DIR, join("/private", "config"));
  assert.equal(env.HOME, "/private");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
});

test("OpenCode waits for MCP readiness and stops its server when a turn is cancelled", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "opencode-server-test-"));
  const binary = join(root, "opencode");
  const log = join(root, "calls.jsonl");
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, pid: process.pid, password: process.env.OPENCODE_PASSWORD }) + '\\n');
if (args[0] === 'serve') {
  console.log(JSON.stringify({ url: 'http://127.0.0.1:1234' }));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else console.log(JSON.stringify({ data: [{ name: 'artifact_tools', status: { status: 'connected' } }] }));
`);
  chmodSync(binary, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const abort = new AbortController();
  await assert.rejects(withOpenCodeServer(binary, { cwd: root, env: process.env, signal: abort.signal, timeoutMs: 5_000, mcpServers: ["artifact_tools"] }, async (_url, env, signal) => {
    assert.ok(readFileSync(log, "utf8").includes('"api"'));
    assert.ok(env.OPENCODE_PASSWORD);
    abort.abort(new Error("cancelled by test"));
    signal.throwIfAborted();
  }), /cancelled by test/);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; pid: number; password: string });
  assert.equal(calls[0].password, calls[1].password);
  assert.throws(() => process.kill(calls[0].pid, 0), /ESRCH/);
});

test("OpenCode classification transfers only credentials and deletes its isolated database", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "opencode-classifier-test-"));
  const binary = join(root, "opencode");
  const log = join(root, "calls.jsonl");
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, data: process.env.XDG_DATA_HOME, home: process.env.HOME, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) }) + '\\n');
if (args[0] === '--version') console.log('opencode v2.0.31');
else if (args[0] === 'auth' && args[1] === 'export') console.log('[{"id":"fixture-credential"}]');
else if (args[0] === 'auth' && args[1] === 'import') {
  let input = ''; process.stdin.on('data', data => input += data);
  process.stdin.on('end', () => { if (JSON.parse(input)[0].id !== 'fixture-credential') process.exitCode = 2; });
} else console.log(JSON.stringify({ type: 'text', sessionID: 'classification-only', part: { text: 'CLASSIFIED' } }));
`);
  chmodSync(binary, 0o755);
  const previous = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = binary;
  const provider = new OpenCodeProvider(new SessionStore("opencode", join(root, "sessions.json")));
  t.after(async () => { await provider.shutdown(); if (previous === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = previous; rmSync(root, { recursive: true, force: true }); });
  assert.equal(await provider.evaluateParticipation("classify", { model: "openai/gpt-5.6-luna", effort: "low", timeoutMs: 5_000 }), "CLASSIFIED");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; data: string; home: string; config: { permissions: { effect: string }[]; providers?: unknown } });
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [["--version"], ["auth", "export"], ["auth", "import"], ["run", "--format"]]);
  assert.notEqual(calls[1].data, calls[2].data);
  assert.equal(calls[2].data, calls[3].data);
  assert.ok(calls[3].config.providers);
  assert.ok(calls[3].config.permissions.every(rule => rule.effect === "deny"));
  assert.ok(calls.every(call => !call.args.includes("--pure")));
  assert.equal(existsSync(calls[3].home), false);
  assert.equal(existsSync(join(root, "sessions.json")), false);
});
