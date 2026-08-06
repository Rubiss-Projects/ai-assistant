import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, isUnsupported } from "../src/sessionManager.js";
import { createProvider } from "../src/providers/index.js";
import { CopilotProvider } from "../src/providers/copilot.js";
import { CodexProvider } from "../src/providers/codex.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";
import { UnsupportedError } from "../src/providers/types.js";
import { ProviderStore } from "../src/common/providerStore.js";

function makeStore(): ProviderStore {
  const dir = mkdtempSync(join(tmpdir(), "ai-provider-"));
  return new ProviderStore(join(dir, "providers.json"));
}

test("createProvider returns the matching provider implementation", () => {
  assert.ok(createProvider("copilot") instanceof CopilotProvider);
  assert.ok(createProvider("codex") instanceof CodexProvider);
  assert.ok(createProvider("opencode") instanceof OpenCodeProvider);
});

test("createProvider rejects unknown providers", () => {
  assert.throws(() => createProvider("does-not-exist"), /Unknown PROVIDER/);
});

test("SessionManager facade selects and exposes the active provider", () => {
  const codex = new SessionManager("codex");
  assert.equal(codex.name, "codex");
  assert.equal(codex.displayName, "OpenAI Codex");

  const opencode = new SessionManager("opencode");
  assert.equal(opencode.name, "opencode");
  assert.equal(opencode.displayName, "OpenCode");
});

test("Codex provider reports unsupported features via UnsupportedError", async () => {
  const codex = new CodexProvider();
  const err = await codex.listAgents().catch((e: unknown) => e);
  assert.ok(err instanceof UnsupportedError);
  assert.ok(isUnsupported(err));
  assert.match((err as Error).message, /does not support/i);
});

test("OpenCode provider reports unsupported features via UnsupportedError", async () => {
  const opencode = new OpenCodeProvider();
  const err = await opencode.compact().catch((e: unknown) => e);
  assert.ok(err instanceof UnsupportedError);
  assert.ok(isUnsupported(err));
});

test("OpenCode provider returns empty MCP status (not configured via this bot)", async () => {
  const opencode = new OpenCodeProvider();
  assert.deepEqual(opencode.getMcpStatus("user-1"), []);
});

test("SessionManager switches active provider per key and falls back to default", async () => {
  const sm = new SessionManager("codex", makeStore());
  assert.equal(sm.activeProviderName("user-9"), "codex");
  await sm.setSessionProvider("user-9", "opencode");
  assert.equal(sm.activeProviderName("user-9"), "opencode");
  assert.equal(sm.activeProviderDisplayName("user-9"), "OpenCode");
  // Other keys unaffected, fall back to the default provider.
  assert.equal(sm.activeProviderName("unrelated-key"), "codex");
});

test("setting a session provider to the default clears the override", async () => {
  const sm = new SessionManager("codex", makeStore());
  await sm.setSessionProvider("user-9", "opencode");
  assert.equal(sm.activeProviderName("user-9"), "opencode");
  await sm.setSessionProvider("user-9", "codex"); // default provider
  assert.equal(sm.activeProviderName("user-9"), "codex");
});

test("setSessionProvider rejects unknown providers", () => {
  const sm = new SessionManager("codex", makeStore());
  assert.throws(() => sm.setSessionProvider("user-9", "does-not-exist"), /Unknown provider/);
});

test("SessionManager rejects an invalid default provider", () => {
  assert.throws(() => new SessionManager("nope"), /Unknown PROVIDER/);
});

test("session provider override persists across SessionManager instances", async () => {
  const store = makeStore();
  const first = new SessionManager("codex", store);
  await first.setSessionProvider("user-9", "opencode");

  const second = new SessionManager("codex", store);
  assert.equal(second.activeProviderName("user-9"), "opencode");
});
