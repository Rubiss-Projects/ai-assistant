import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotProvider } from "../src/providers/copilot.js";

type AssistantResult = { data: { content: string } };

type SessionLike = {
  sessionId: string;
  send?: (options: unknown) => Promise<string>;
  on?: (handler: (event: any) => void) => () => void;
  abort?: () => Promise<void>;
  getEvents?: () => Promise<unknown[]>;
  rpc?: {
    model: {
      getCurrent: () => Promise<{ modelId?: string }>;
    };
  };
  disconnect: () => Promise<void>;
};

type StoreLike = {
  get: (key: string) => string | undefined;
  set: (key: string, sessionId: string) => void;
  delete: (key: string) => void;
};

type ClientLike = {
  createSession: (config?: unknown) => Promise<SessionLike>;
  resumeSession: (sessionId: string, config?: unknown) => Promise<SessionLike>;
  start: () => Promise<void>;
  stop: () => Promise<Error[]>;
};

type TestableCopilotProvider = {
  sendMessage: CopilotProvider["sendMessage"];
  getHistory: CopilotProvider["getHistory"];
  getCurrentModel: CopilotProvider["getCurrentModel"];
  setSessionWorkingDir: CopilotProvider["setSessionWorkingDir"];
  sessions: Map<string, SessionLike>;
  sessionOperationQueues: Map<string, Promise<unknown>>;
  sessionWorkingDirectories: Map<string, string>;
  store: StoreLike;
  client: ClientLike;
};

function createTestManager(storedSessions: Record<string, string> = {}): TestableCopilotProvider {
  const manager = new CopilotProvider() as unknown as TestableCopilotProvider;
  manager.store = {
    get: (key) => storedSessions[key],
    set: (key, sessionId) => {
      storedSessions[key] = sessionId;
    },
    delete: (key) => {
      delete storedSessions[key];
    },
  };
  return manager;
}

test("sendMessage resumes and retries once when cached session is missing from Copilot", async () => {
  const storedSessions: Record<string, string> = { "user-1": "stale-session" };
  const manager = createTestManager(storedSessions);
  let staleSendCalls = 0;
  let freshSendCalls = 0;
  let staleDisconnected = false;
  let resumeCalls = 0;
  let createCalls = 0;

  const staleSession: SessionLike = {
    sessionId: "stale-session",
    on: () => () => {},
    abort: async () => {},
    send: async () => {
      staleSendCalls += 1;
      throw new Error("Request session.send failed with message: Session not found: stale-session");
    },
    disconnect: async () => {
      staleDisconnected = true;
    },
  };

  const freshSession: SessionLike = {
    sessionId: "fresh-session",
    on: (handler) => {
      queueMicrotask(() => {
        handler({ type: "assistant.message", data: { content: "retry ok" } });
        handler({ type: "session.idle", data: {} });
      });
      return () => {};
    },
    abort: async () => {},
    send: async (options) => {
      freshSendCalls += 1;
      assert.deepEqual(options, { prompt: "hello" });
      return "message-1";
    },
    disconnect: async () => {},
  };

  manager.sessions.set("user-1", staleSession);
  manager.client = {
    createSession: async () => {
      createCalls += 1;
      return freshSession;
    },
    resumeSession: async (sessionId) => {
      resumeCalls += 1;
      assert.equal(sessionId, "stale-session");
      return freshSession;
    },
    start: async () => {},
    stop: async () => [],
  };

  const response = await manager.sendMessage("user-1", "hello");

  assert.equal(response.content, "retry ok");
  assert.deepEqual(response.attachments, []);
  assert.equal(staleSendCalls, 1);
  assert.equal(freshSendCalls, 1);
  assert.equal(staleDisconnected, true);
  assert.equal(resumeCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(storedSessions["user-1"], "fresh-session");
  assert.equal(manager.sessions.get("user-1"), freshSession);
});

test("sendMessage does not evict or retry non-stale-session errors", async () => {
  const storedSessions: Record<string, string> = { "user-1": "cached-session" };
  const manager = createTestManager(storedSessions);
  let disconnectCalls = 0;
  let resumeCalls = 0;

  const cachedSession: SessionLike = {
    sessionId: "cached-session",
    on: () => () => {},
    abort: async () => {},
    send: async () => {
      throw new Error("rate limited");
    },
    disconnect: async () => {
      disconnectCalls += 1;
    },
  };

  manager.sessions.set("user-1", cachedSession);
  manager.client = {
    createSession: async () => {
      throw new Error("should not create");
    },
    resumeSession: async () => {
      resumeCalls += 1;
      throw new Error("should not resume");
    },
    start: async () => {},
    stop: async () => [],
  };

  await assert.rejects(() => manager.sendMessage("user-1", "hello"), /rate limited/);

  assert.equal(disconnectCalls, 0);
  assert.equal(resumeCalls, 0);
  assert.equal(storedSessions["user-1"], "cached-session");
  assert.equal(manager.sessions.get("user-1"), cachedSession);
});

test("long Copilot work reports progress and is explicitly aborted at the hard timeout", async () => {
  const previousProgress = process.env.AI_PROGRESS_INTERVAL_MS;
  const previousTimeout = process.env.COPILOT_TIMEOUT_MS;
  process.env.AI_PROGRESS_INTERVAL_MS = "20";
  process.env.COPILOT_TIMEOUT_MS = "70";
  try {
    const manager = createTestManager();
    let abortCalls = 0;
    let progressCalls = 0;
    const session: SessionLike = {
      sessionId: "long-session",
      on: () => () => {},
      send: async () => "message-1",
      abort: async () => { abortCalls += 1; },
      disconnect: async () => {},
    };
    manager.sessions.set("user-1", session);

    await assert.rejects(
      () => manager.sendMessage("user-1", "long task", undefined, {
        onProgress: () => { progressCalls += 1; },
      }),
      /hard timeout and was cancelled/,
    );
    assert.ok(progressCalls >= 1);
    assert.equal(abortCalls, 1);
  } finally {
    if (previousProgress === undefined) delete process.env.AI_PROGRESS_INTERVAL_MS;
    else process.env.AI_PROGRESS_INTERVAL_MS = previousProgress;
    if (previousTimeout === undefined) delete process.env.COPILOT_TIMEOUT_MS;
    else process.env.COPILOT_TIMEOUT_MS = previousTimeout;
  }
});

test("Copilot evicts a session when cancellation cannot be confirmed", async () => {
  const previousTimeout = process.env.COPILOT_TIMEOUT_MS;
  const previousGrace = process.env.AI_CANCELLATION_GRACE_MS;
  process.env.COPILOT_TIMEOUT_MS = "30";
  process.env.AI_CANCELLATION_GRACE_MS = "20";
  try {
    const manager = createTestManager();
    let disconnectCalls = 0;
    const session: SessionLike = {
      sessionId: "hung-session",
      on: () => () => {},
      send: async () => "message-1",
      abort: () => new Promise(() => {}),
      disconnect: async () => { disconnectCalls += 1; },
    };
    manager.sessions.set("user-1", session);

    const error = await manager.sendMessage("user-1", "long task").catch((caught: unknown) => caught);
    assert.equal((error as { cancellationConfirmed?: boolean }).cancellationConfirmed, false);
    assert.equal(manager.sessions.has("user-1"), false);
    assert.equal(disconnectCalls, 1);
  } finally {
    if (previousTimeout === undefined) delete process.env.COPILOT_TIMEOUT_MS;
    else process.env.COPILOT_TIMEOUT_MS = previousTimeout;
    if (previousGrace === undefined) delete process.env.AI_CANCELLATION_GRACE_MS;
    else process.env.AI_CANCELLATION_GRACE_MS = previousGrace;
  }
});

test("getHistory returns null without resuming a stored session", async () => {
  const storedSessions: Record<string, string> = { "user-1": "stored-session" };
  const manager = createTestManager(storedSessions);
  let createCalls = 0;
  let resumeCalls = 0;

  manager.client = {
    createSession: async () => {
      createCalls += 1;
      throw new Error("should not create");
    },
    resumeSession: async () => {
      resumeCalls += 1;
      throw new Error("should not resume");
    },
    start: async () => {},
    stop: async () => [],
  };

  const history = await manager.getHistory("user-1");

  assert.equal(history, null);
  assert.equal(createCalls, 0);
  assert.equal(resumeCalls, 0);
  assert.equal(storedSessions["user-1"], "stored-session");
});

test("changing a Copilot workspace evicts the session bound to the old directory", async () => {
  const manager = createTestManager();
  let disconnectCalls = 0;
  manager.sessions.set("user-1", {
    sessionId: "old-workspace-session",
    disconnect: async () => { disconnectCalls += 1; },
  });

  manager.setSessionWorkingDir("user-1", mkdtempSync(join(tmpdir(), "copilot-workspace-")));
  await manager.sessionOperationQueues.get("user-1");

  assert.equal(manager.sessions.has("user-1"), false);
  assert.equal(disconnectCalls, 1);
});

test("repeating the same Copilot workspace preserves the live conversation", () => {
  const storedSessions: Record<string, string> = { "user-1": "live-session" };
  const manager = createTestManager(storedSessions);
  const workspace = mkdtempSync(join(tmpdir(), "copilot-workspace-"));
  const session: SessionLike = {
    sessionId: "live-session",
    disconnect: async () => { throw new Error("should not disconnect"); },
  };
  manager.sessions.set("user-1", session);
  manager.sessionWorkingDirectories.set("user-1", workspace);

  manager.setSessionWorkingDir("user-1", workspace);

  assert.equal(manager.sessions.get("user-1"), session);
  assert.equal(storedSessions["user-1"], "live-session");
  assert.equal(manager.sessionOperationQueues.has("user-1"), false);
});

test("repeating the default Copilot workspace preserves a persisted conversation after restart", () => {
  const storedSessions: Record<string, string> = { "user-1": "persisted-session" };
  const manager = createTestManager(storedSessions);

  manager.setSessionWorkingDir("user-1", process.cwd());

  assert.equal(storedSessions["user-1"], "persisted-session");
  assert.equal(manager.sessionOperationQueues.has("user-1"), false);
});

test("changing a Copilot workspace waits for active session work before disconnecting", async () => {
  const manager = createTestManager();
  let releaseWork!: () => void;
  const activeWork = new Promise<void>((resolve) => { releaseWork = resolve; });
  let disconnectCalls = 0;
  manager.sessions.set("user-1", {
    sessionId: "busy-session",
    disconnect: async () => { disconnectCalls += 1; },
  });
  manager.sessionOperationQueues.set("user-1", activeWork);

  manager.setSessionWorkingDir("user-1", mkdtempSync(join(tmpdir(), "copilot-workspace-")));
  const transition = manager.sessionOperationQueues.get("user-1")!;
  await Promise.resolve();
  assert.equal(disconnectCalls, 0);
  assert.equal(manager.sessions.has("user-1"), true);

  releaseWork();
  await transition;
  assert.equal(disconnectCalls, 1);
  assert.equal(manager.sessions.has("user-1"), false);
});

test("getHistory maps message events and excludes non-history events", async () => {
  const manager = createTestManager();
  const session: SessionLike = {
    sessionId: "active-session",
    getEvents: async () => [
      {
        type: "user.message",
        data: { content: "hello", transformedContent: "<prompt>hello</prompt>" },
      },
      { type: "assistant.turn_start", data: { turnId: "turn-1" } },
      { type: "assistant.message_delta", data: { deltaContent: "hi" } },
      {
        type: "assistant.message",
        data: { content: "hi there", messageId: "message-1", turnId: "turn-1" },
      },
      { type: "abort", data: { reason: "user" } },
      { type: "tool.execution_start", data: { toolCallId: "tool-1", toolName: "read" } },
      {
        type: "assistant.message",
        data: {
          content: "nested result",
          messageId: "message-2",
          turnId: "turn-1",
          parentToolCallId: "tool-1",
        },
      },
    ],
    disconnect: async () => {},
  };
  manager.sessions.set("user-1", session);

  const history = await manager.getHistory("user-1");

  assert.deepEqual(history, [
    { type: "user.message", data: { content: "hello" } },
    { type: "assistant.message", data: { content: "hi there" } },
    {
      type: "assistant.message",
      data: { content: "nested result", parentToolCallId: "tool-1" },
    },
  ]);
});

test("getCurrentModel retries once when cached session is missing from Copilot", async () => {
  const storedSessions: Record<string, string> = { "user-1": "stale-session" };
  const manager = createTestManager(storedSessions);
  let staleModelCalls = 0;
  let freshModelCalls = 0;
  let staleDisconnected = false;
  let resumeCalls = 0;

  const staleSession: SessionLike = {
    sessionId: "stale-session",
    rpc: {
      model: {
        getCurrent: async () => {
          staleModelCalls += 1;
          throw new Error("Request model.getCurrent failed with message: Session not found: stale-session");
        },
      },
    },
    disconnect: async () => {
      staleDisconnected = true;
    },
  };

  const freshSession: SessionLike = {
    sessionId: "fresh-session",
    rpc: {
      model: {
        getCurrent: async () => {
          freshModelCalls += 1;
          return { modelId: "claude-haiku-4.5" };
        },
      },
    },
    disconnect: async () => {},
  };

  manager.sessions.set("user-1", staleSession);
  manager.client = {
    createSession: async () => {
      throw new Error("should not create");
    },
    resumeSession: async (sessionId) => {
      resumeCalls += 1;
      assert.equal(sessionId, "stale-session");
      return freshSession;
    },
    start: async () => {},
    stop: async () => [],
  };

  const model = await manager.getCurrentModel("user-1");

  assert.equal(model, "claude-haiku-4.5");
  assert.equal(staleModelCalls, 1);
  assert.equal(freshModelCalls, 1);
  assert.equal(staleDisconnected, true);
  assert.equal(resumeCalls, 1);
  assert.equal(storedSessions["user-1"], "fresh-session");
  assert.equal(manager.sessions.get("user-1"), freshSession);
});
