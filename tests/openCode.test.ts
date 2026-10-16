import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertOpenCodeV2, openCodeChildEnvironment, openCodeIsolatedEnvironment, OpenCodeProvider } from "../src/providers/opencode.js";
import { OPENCODE_API_KEY_ENVIRONMENT_KEYS } from "../src/common/providerSecurity.js";
import { withOpenCodeServer } from "../src/providers/openCodeServer.js";
import { SessionStore } from "../src/common/sessionStore.js";

test("OpenCode requires V2 and isolates config without losing the persistent data path", () => {
  for (const version of ["opencode v2.0.31\n", "2.0.31", "2.1.0-beta.1"]) assert.doesNotThrow(() => assertOpenCodeV2(version));
  for (const version of ["1.19.3", "2.0.24", "unknown", "3.0.0"]) assert.throws(() => assertOpenCodeV2(version), /V2 .*is required/);
  const env = openCodeIsolatedEnvironment({ HOME: "/operator", XDG_DATA_HOME: "/persistent", XDG_CONFIG_HOME: "/ambient-xdg", OPENCODE_CONFIG_DIR: "/ambient" }, "/private");
  assert.equal(env.XDG_DATA_HOME, "/persistent");
  assert.equal(env.OPENCODE_CONFIG_DIR, join("/private", "config"));
  assert.equal(env.XDG_CONFIG_HOME, join("/private", "xdg-config"));
  assert.equal(env.HOME, "/private");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
});

test("OpenCode adds host grants without replacing legacy or native permission policies", () => {
  const bridge = { command: "node", args: ["bridge.js"], env: {} };
  for (const permission of ["deny", { bash: "deny", read: { "*": "ask", ".env": "deny" } }]) {
    const config = JSON.parse(openCodeChildEnvironment({ AI_ASSISTANT_SECURITY_MODE: "unrestricted", OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission }) }, bridge).OPENCODE_CONFIG_CONTENT);
    assert.equal(config.permissions, undefined);
    assert.deepEqual(config.permission, { ...(typeof permission === "string" ? { "*": permission } : permission), "artifact_tools_*": "allow" });
  }
  const permissions = [{ action: "shell", resource: "*", effect: "deny" }];
  const config = JSON.parse(openCodeChildEnvironment({ AI_ASSISTANT_SECURITY_MODE: "unrestricted", OPENCODE_CONFIG_CONTENT: JSON.stringify({ permissions }) }, bridge).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.permissions, [...permissions, { action: "artifact_tools_*", resource: "*", effect: "allow" }]);
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
} else {
  const attempts = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter(line => line.includes('"api"')).length;
  console.log(JSON.stringify({ data: [
    { name: 'artifact_tools', status: { status: 'connected' } },
    { name: 'custom_tools', status: { status: attempts < 2 ? 'pending' : 'connected' } },
    { name: 'disabled_tools', status: { status: 'disabled' } },
  ] }));
}
`);
  chmodSync(binary, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const abort = new AbortController();
  await assert.rejects(withOpenCodeServer(binary, { cwd: root, env: process.env, signal: abort.signal, timeoutMs: 5_000, mcpServers: ["artifact_tools"] }, async (_url, env, signal) => {
    assert.equal(readFileSync(log, "utf8").split("\n").filter(line => line.includes('"api"')).length, 2);
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
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; data: string; home: string; config: { permissions: { effect: string }[]; providers?: Record<string, { models: Record<string, { settings: { reasoningEffort: string } }> }> } });
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [["--version"], ["auth", "export"], ["auth", "import"], ["run", "--format"]]);
  assert.notEqual(calls[1].data, calls[2].data);
  assert.equal(calls[2].data, calls[3].data);
  assert.deepEqual(calls[3].config.providers?.openai.models["gpt-5.6-luna"], { settings: { reasoningEffort: "low" } });
  assert.ok(calls[3].config.permissions.every(rule => rule.effect === "deny"));
  assert.ok(calls.every(call => !call.args.includes("--pure")));
  assert.equal(existsSync(calls[3].home), false);
  assert.equal(existsSync(join(root, "sessions.json")), false);
});

test("OpenCode status recognizes supported environment keys with an empty credential list", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "opencode-auth-test-"));
  const binary = join(root, "opencode");
  writeFileSync(binary, `#!/usr/bin/env node
console.log(process.argv[2] === '--version' ? 'opencode v2.0.31' : '[]');
`);
  chmodSync(binary, 0o755);
  const names = [...OPENCODE_API_KEY_ENVIRONMENT_KEYS, "OPENCODE_BIN", "AI_ASSISTANT_SECURITY_MODE", "AI_ASSISTANT_WORKSPACE_ROOT"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const key of OPENCODE_API_KEY_ENVIRONMENT_KEYS) delete process.env[key];
  process.env.OPENCODE_BIN = binary;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = root;
  const provider = new OpenCodeProvider(new SessionStore("opencode", join(root, "sessions.json")));
  t.after(async () => { await provider.shutdown(); for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } rmSync(root, { recursive: true, force: true }); });
  assert.equal((await provider.getStatus()).authStatus.isAuthenticated, false);
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const) {
    process.env[key] = "fixture-key";
    const status = (await provider.getStatus()).authStatus;
    assert.equal(status.isAuthenticated, true);
    assert.equal(status.login, key);
    assert.equal(status.authType, "environment API key");
    delete process.env[key];
  }
});
