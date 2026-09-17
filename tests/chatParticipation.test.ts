import assert from "node:assert/strict";
import test from "node:test";
import { ChatParticipation, parseParticipationDecision, participationMode, type ConversationMessage } from "../src/common/chatParticipation.js";
import { explicitlyMentionsBot, participationContext } from "../src/common/discordParticipation.js";

const sleep = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const message = (id: string, content = "question"): ConversationMessage => ({ id, content, authorId: "alice", authorName: "Alice", bot: false, attachmentCount: 0 });
function harness(decide: (prompt: string) => Promise<string> = async () => '{"action":"ignore"}') {
  const replies: string[] = [], reactions: string[] = [], calls: string[] = [];
  const coordinator = new ChatParticipation<ConversationMessage>({
    id: value => value.id, context: async values => values,
    classify: async prompt => { calls.push(prompt); return decide(prompt); },
    reply: async value => { replies.push(value.id); },
    react: async (value, emoji) => { reactions.push(value.id + emoji); },
    onError: () => {},
  }, { debounceMs: 5, maxWaitMs: 15, cooldownMs: 1000 });
  return { coordinator, replies, reactions, calls };
}

test("shared defaults to smart, dedicated to always; overrides are validated", () => {
  assert.equal(participationMode(true, ""), "smart");
  assert.equal(participationMode(false, ""), "always");
  assert.equal(participationMode(true, "mentions-only"), "mentions-only");
  assert.throws(() => participationMode(true, "sometimes"));
});

test("reply notification mentions are not explicit bot mentions", () => {
  assert.equal(explicitlyMentionsBot({ content: "thanks" }, "123"), false);
  assert.equal(explicitlyMentionsBot({ content: "<@123> why?" }, "123"), true);
  assert.equal(explicitlyMentionsBot({ content: "<@!123> why?" }, "123"), true);
});

test("malformed output, unknown targets and unapproved reactions stay silent", () => {
  for (const value of ["invalid", "null", '{"action":"reply","messageId":"other","directed":true}',
    '{"action":"reply","messageId":"1"}', '{"action":"react","messageId":"1","emoji":"✅"}']) {
    assert.deepEqual(parseParticipationDecision(value, ["1"]), { action: "ignore" });
  }
  assert.deepEqual(parseParticipationDecision('{"action":"reply","messageId":"1","directed":true}', ["1"]), { action: "reply", messageId: "1", directed: true });
});

test("bursts use one evaluation and explicit requests bypass classification", async () => {
  const h = harness();
  h.coordinator.enqueue("thread", message("1"), false);
  h.coordinator.enqueue("thread", message("2"), false);
  await sleep();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0]).candidateIds, ["1", "2"]);
  h.coordinator.enqueue("thread", message("3"), true);
  await sleep();
  assert.deepEqual(h.replies, ["3"]);
  assert.equal(h.calls.length, 1);
  await h.coordinator.stop();
});

test("new messages invalidate an in-flight decision before any reply", async () => {
  let resolve!: (value: string) => void;
  const h = harness(async () => new Promise<string>(done => { resolve = done; }));
  h.coordinator.enqueue("thread", message("1"), false);
  await sleep();
  h.coordinator.enqueue("thread", message("2", "Someone already answered"), false);
  resolve('{"action":"reply","messageId":"1","directed":false}');
  await sleep();
  assert.deepEqual(h.replies, []);
  assert.equal(h.calls.length, 2);
  resolve('{"action":"ignore"}');
  await sleep();
  await h.coordinator.stop();
});

test("cooldown suppresses ambient replies/reactions but permits directed follow-ups", async () => {
  const h = harness(async prompt => {
    const id = JSON.parse(prompt).candidateIds[0];
    return JSON.stringify({ action: "reply", messageId: id, directed: id === "3" });
  });
  h.coordinator.enqueue("thread", message("1"), true);
  await sleep();
  h.coordinator.enqueue("thread", message("2"), false);
  await sleep();
  h.coordinator.enqueue("thread", message("3", "why?"), false);
  await sleep();
  assert.deepEqual(h.replies, ["1", "3"]);
  await h.coordinator.stop();
});

test("evaluator failure stays silent; next explicit request works", async () => {
  const h = harness(async () => { throw new Error("offline"); });
  h.coordinator.enqueue("thread", message("1"), false);
  await sleep();
  h.coordinator.enqueue("thread", message("2"), true);
  await sleep();
  assert.deepEqual(h.replies, ["2"]);
  await h.coordinator.stop();
});

test("reactions do not invoke the response handler", async () => {
  const h = harness(async () => '{"action":"react","messageId":"1","emoji":"👍"}');
  h.coordinator.enqueue("thread", message("1", "thanks!"), false);
  await sleep();
  assert.deepEqual(h.replies, []);
  assert.deepEqual(h.reactions, ["1👍"]);
  await h.coordinator.stop();
});

test("slash turns serialize with classification and invalidate stale ambient replies", async () => {
  let resolve!: (value: string) => void;
  const h = harness(async () => new Promise<string>(done => { resolve = done; }));
  h.coordinator.enqueue("thread", message("1"), false);
  await sleep();
  const turn = h.coordinator.runExplicit("thread", async () => { h.replies.push("slash"); });
  resolve('{"action":"reply","messageId":"1","directed":false}');
  await turn;
  assert.deepEqual(h.replies, ["slash"]);
  await h.coordinator.stop();
});

test("shutdown cancels a pending debounce", async () => {
  const h = harness();
  h.coordinator.enqueue("thread", message("1"), false);
  await h.coordinator.stop();
  await sleep();
  assert.deepEqual(h.calls, []);
});

test("history retains skipped messages and bot context, excludes unauthorized authors", async () => {
  const make = (id: string, author: string, bot = false) => ({ id, channelId: "thread", content: id,
    createdTimestamp: Number(id), author: { id: author, username: author, bot }, attachments: new Map() });
  const history = [make("1", "alice"), make("2", "blocked"), make("3", "bot", true)];
  const latest = { ...make("4", "bob"), reference: { messageId: "3" },
    channel: { messages: { fetch: async () => new Map(history.map(value => [value.id, value])) }, permissionsFor: () => ({ has: () => true }) } };
  const context = await participationContext([latest as never], "bot", id => id !== "blocked" && id !== "bot");
  assert.deepEqual(context.map(value => value.id), ["1", "3", "4"]);
  assert.equal(context.at(-1)?.replyToAuthorId, "bot");
});

test("history is not fetched when a requester lacks ReadMessageHistory", async () => {
  const latest = { id: "1", content: "why?", createdTimestamp: 1,
    author: { id: "alice", username: "Alice", bot: false }, attachments: new Map(),
    channel: { messages: { fetch: async () => { throw new Error("must not fetch"); } }, permissionsFor: () => ({ has: () => false }) } };
  const context = await participationContext([latest as never], "bot", () => true);
  assert.deepEqual(context.map(value => value.id), ["1"]);
});

test("acknowledgment can react after an explicit reply, but repeated reactions cool down", async () => {
  const h = harness(async prompt => JSON.stringify({ action: "react", messageId: JSON.parse(prompt).candidateIds[0], emoji: "👍" }));
  h.coordinator.enqueue("thread", message("1"), true);
  await sleep();
  h.coordinator.enqueue("thread", message("2", "thanks"), false);
  await sleep();
  h.coordinator.enqueue("thread", message("3", "great"), false);
  await sleep();
  assert.deepEqual(h.reactions, ["2👍"]);
  await h.coordinator.stop();
});

test("slash context uses the requester permissions and identity, not the bot's", async () => {
  let permissionSubject = "";
  let fetched = false;
  const source = { id: "1", content: "thinking", createdTimestamp: 1,
    author: { id: "bot", username: "Bot", bot: true }, attachments: new Map(),
    channel: {
      messages: { fetch: async () => { fetched = true; return new Map(); } },
      permissionsFor: (id: string) => { permissionSubject = id; return { has: () => false }; },
    },
  };
  const context = await participationContext([source as never], "bot", id => id === "alice", {
    authorId: "alice", authorName: "Alice", content: "What did we decide?",
  });
  assert.equal(permissionSubject, "alice");
  assert.equal(fetched, false);
  assert.equal(context[0].authorId, "alice");
  assert.equal(context[0].bot, false);
  assert.equal(context[0].content, "What did we decide?");
});

test("stop does not wait on an active answer or start another queued explicit answer", async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let finish!: () => void;
  const active = new Promise<void>(resolve => { finish = resolve; });
  const replies: string[] = [];
  const coordinator = new ChatParticipation<ConversationMessage>({
    id: value => value.id, context: async values => values,
    classify: async () => '{"action":"ignore"}',
    reply: async value => { replies.push(value.id); began(); await active; },
    react: async () => {}, onError: () => {},
  });
  coordinator.enqueue("thread", message("1"), true);
  coordinator.enqueue("thread", message("2"), true);
  await started;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([coordinator.stop(), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Shutdown waited on the active provider")), 100);
    })]);
  } finally { clearTimeout(deadline); finish(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, ["1"]);
});

test("slash-only traffic evicts completed idle threads while retaining active threads", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const coordinator = new ChatParticipation<ConversationMessage>({
    id: value => value.id, context: async values => values,
    classify: async () => '{"action":"ignore"}',
    reply: async () => {}, react: async () => {}, onError: () => {},
  });
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  try {
    await coordinator.runExplicit("old", async () => {});
    await new Promise(resolve => setImmediate(resolve));
    const active = coordinator.runExplicit("active", () => blocked);
    await new Promise(resolve => setTimeout(resolve, 5));
    now += 60_001;
    await coordinator.runExplicit("new", async () => {});
    const threads = (coordinator as any).threads as Map<string, unknown>;
    assert.equal(threads.has("old"), false);
    assert.equal(threads.has("active"), true);
    assert.equal(threads.has("new"), true);
    finish();
    await active;
  } finally { finish(); await coordinator.stop(); }
});
