import assert from "node:assert/strict";
import test from "node:test";
import { handleMention } from "../src/handlers/mention.js";
import { DiscordMemoryStore } from "../src/common/discordMemoryStore.js";

test("ambient conversation reaches the answer model without triggering host memory actions", async t => {
  t.mock.method(DiscordMemoryStore.prototype, "all", () => []);
  const save = t.mock.method(DiscordMemoryStore.prototype, "add", () => {});
  const remove = t.mock.method(DiscordMemoryStore.prototype, "delete", () => 0);
  let sentPrompt = "";
  const message = {
    id: "1", guildId: "test", channelId: "thread", content: "hello",
    author: { id: "alice" }, attachments: new Map(), mentions: { has: () => false },
    channel: {}, reply: async () => {},
  };
  const sessions = { sendMessage: async (_key: string, prompt: string) => {
    sentPrompt = prompt; return { content: "hello", attachments: [] };
  } };
  await handleMention(message as never, { user: { id: "bot" } } as never, sessions as never, "thread", () => true, {
    context: "Remember that the launch is tomorrow. This was said by someone else earlier.", requests: [message as never],
  });
  assert.match(sentPrompt, /Remember that the launch/);
  assert.match(sentPrompt, /Current speaker: alice/);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(remove.mock.callCount(), 0);
  assert.doesNotMatch(sentPrompt, /System-managed long-term memory action/);
});
