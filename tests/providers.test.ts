import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, isUnsupported } from "../src/sessionManager.js";
import { createProvider } from "../src/providers/index.js";
import { CopilotProvider } from "../src/providers/copilot.js";
import { CodexProvider } from "../src/providers/codex.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";
import { RunTimeoutError, UnsupportedError } from "../src/providers/types.js";
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

test("Codex provider reads the default reasoning effort from the environment", async () => {
  const previous = process.env.CODEX_REASONING_EFFORT;
  process.env.CODEX_REASONING_EFFORT = "max";
  try {
    const codex = new CodexProvider();
    assert.equal(await codex.getCurrentReasoningEffort("user-1"), "max");
  } finally {
    if (previous === undefined) delete process.env.CODEX_REASONING_EFFORT;
    else process.env.CODEX_REASONING_EFFORT = previous;
  }
});

test("Codex long runs report progress and abort at the hard timeout", async () => {
  const previousProgress = process.env.AI_PROGRESS_INTERVAL_MS;
  const previousTimeout = process.env.CODEX_TIMEOUT_MS;
  process.env.AI_PROGRESS_INTERVAL_MS = "10";
  process.env.CODEX_TIMEOUT_MS = "40";
  try {
    const codex = new CodexProvider();
    const internal = codex as unknown as {
      sessions: Map<string, { id: string; run: (_input: unknown, options: { signal: AbortSignal }) => Promise<never> }>;
    };
    let abortObserved = false;
    let progressCalls = 0;
    internal.sessions.set("long-codex-run", {
      id: "test-thread",
      run: (_input, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
    });

    const error = await codex.sendMessage("long-codex-run", "work", undefined, {
      onProgress: () => { progressCalls += 1; },
    }).catch((caught: unknown) => caught);
    assert.ok(error instanceof RunTimeoutError);
    assert.equal(error.cancellationConfirmed, true);
    assert.equal(abortObserved, true);
    assert.ok(progressCalls >= 1);
  } finally {
    if (previousProgress === undefined) delete process.env.AI_PROGRESS_INTERVAL_MS;
    else process.env.AI_PROGRESS_INTERVAL_MS = previousProgress;
    if (previousTimeout === undefined) delete process.env.CODEX_TIMEOUT_MS;
    else process.env.CODEX_TIMEOUT_MS = previousTimeout;
  }
});

test("Codex hard deadline releases the request when abort does not settle", async () => {
  const previousTimeout = process.env.CODEX_TIMEOUT_MS;
  const previousGrace = process.env.AI_CANCELLATION_GRACE_MS;
  process.env.CODEX_TIMEOUT_MS = "30";
  process.env.AI_CANCELLATION_GRACE_MS = "20";
  try {
    const codex = new CodexProvider();
    const internal = codex as unknown as {
      sessions: Map<string, { id: string; run: () => Promise<never> }>;
    };
    internal.sessions.set("hung-codex-run", {
      id: "hung-thread",
      run: () => new Promise(() => {}),
    });

    const error = await codex.sendMessage("hung-codex-run", "work").catch((caught: unknown) => caught);
    assert.ok(error instanceof RunTimeoutError);
    assert.equal(error.cancellationConfirmed, false);
    assert.equal(internal.sessions.has("hung-codex-run"), false);
  } finally {
    if (previousTimeout === undefined) delete process.env.CODEX_TIMEOUT_MS;
    else process.env.CODEX_TIMEOUT_MS = previousTimeout;
    if (previousGrace === undefined) delete process.env.AI_CANCELLATION_GRACE_MS;
    else process.env.AI_CANCELLATION_GRACE_MS = previousGrace;
  }
});

test("Codex rejects oversized text attachments before invoking a turn", async () => {
  const previousLimit = process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES;
  process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES = "8";
  const directory = mkdtempSync(join(tmpdir(), "codex-large-attachment-"));
  const file = join(directory, "large.svg");
  writeFileSync(file, "x".repeat(20));
  try {
    const codex = new CodexProvider();
    const internal = codex as unknown as { sessions: Map<string, { id: string; run: () => Promise<never> }> };
    let invoked = false;
    internal.sessions.set("large-file", { id: "thread", run: async () => { invoked = true; throw new Error(); } });
    await assert.rejects(
      () => codex.sendMessage("large-file", "inspect", [{ path: file, displayName: "large.svg", kind: "file" }]),
      /large\.svg.*too large.*20 bytes.*limit 8/,
    );
    assert.equal(invoked, false);
  } finally {
    if (previousLimit === undefined) delete process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES;
    else process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES = previousLimit;
  }
});

test("Codex captures completed image-generation paths without an artifact marker", async () => {
  const previousHome = process.env.CODEX_HOME;
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const codexHome = mkdtempSync(join(tmpdir(), "codex-generated-home-"));
  const generatedDirectory = join(codexHome, "generated_images", "run-1");
  mkdirSync(generatedDirectory, { recursive: true });
  const savedPath = join(generatedDirectory, "result.png");
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  writeFileSync(savedPath, png);
  process.env.CODEX_HOME = codexHome;
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  try {
    const codex = new CodexProvider();
    const internal = codex as unknown as { sessions: Map<string, unknown> };
    const workspace = mkdtempSync(join(tmpdir(), "codex-image-workspace-"));
    codex.setSessionWorkingDir("image-run", workspace);
    internal.sessions.set("image-run", {
      id: "thread",
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: "item.completed", item: { type: "imageGeneration", status: "completed", savedPath } };
          yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "Done." } };
          yield { type: "turn.completed", usage: {} };
        })(),
      }),
    });
    const response = await codex.sendMessage("image-run", "make an image");
    assert.equal(response.content, "Done.");
    assert.equal(response.attachments[0].displayName, "generated-image-1.png");
    assert.deepEqual(response.attachments[0].data, png);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
    else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  }
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
