import assert from "node:assert/strict";
import test from "node:test";
import { classifyMemoryIntent, sourceText } from "../src/utils/discordKnowledge.js";

test("classifies explicit conversational memory writes", () => {
  assert.equal(classifyMemoryIntent("Remember that Dave owes Sam cheese"), "save");
  assert.equal(classifyMemoryIntent("don't forget that Dave owes Sam cheese"), "save");
  assert.equal(classifyMemoryIntent("I don't forget that the meeting is Tuesday"), null);
  assert.equal(classifyMemoryIntent("Could you remember that the trip is in June?"), "save");
  assert.equal(classifyMemoryIntent("keep this for later"), "save");
  assert.equal(classifyMemoryIntent("Commit these contracts to memory"), "save");
  assert.equal(classifyMemoryIntent("Put this in long-term memory, please"), "save");
});

test("does not turn recall questions into memory writes", () => {
  assert.equal(classifyMemoryIntent("What do you remember about the beach plans?"), null);
  assert.equal(classifyMemoryIntent("Do you remember the cheese contract?"), null);
  assert.equal(classifyMemoryIntent("Can you remember what we decided?"), null);
  assert.equal(classifyMemoryIntent("Could you remember where the meeting is?"), null);
  assert.equal(classifyMemoryIntent("Can you remember anything about the beach plans?"), null);
  assert.equal(classifyMemoryIntent("Can you remember the beach plans?"), null);
  assert.equal(classifyMemoryIntent("Remember anything about the beach plans?"), null);
});

test("classifies explicit deletion separately from negated forget", () => {
  assert.equal(classifyMemoryIntent("Forget that cheese contract"), "forget");
  assert.equal(classifyMemoryIntent("Delete the memory about the beach trip"), "forget");
  assert.equal(classifyMemoryIntent("Why do I always forget that agreement?"), null);
});

test("resolves contract IDs in a replied-to summary to exact Discord messages", async () => {
  const invocation = {
    guildId: "guild-1",
    channelId: "summary-channel",
    reference: { messageId: "summary" },
    fetchReference: async () => ({
      content: "Active: CONTRACT-BEN-MARVEL-2026-A",
      url: "https://discord.com/channels/guild-1/summary-channel/summary",
      channelId: "summary-channel",
      author: { id: "assistant", bot: true },
    }),
  };
  const contract = "CONTRACT-BEN-MARVEL-2026-A\nBen shall acquire one heroic copy of Marvel.";
  const client = {
    user: { id: "assistant" },
    rest: {
      get: async () => ({
        total_results: 1,
        messages: [[{
          id: "contract-message",
          channel_id: "contracts-channel",
          content: contract,
          author: { id: "gemini", bot: true, username: "Gemini" },
          timestamp: new Date().toISOString(),
        }]],
      }),
    },
    channels: {
      fetch: async () => ({
        isDMBased: () => false,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
      }),
    },
  };

  const source = await sourceText(
    invocation as never,
    "Commit these contracts to memory",
    client as never,
    "requester",
    () => true,
  );
  assert.match(source.content, /Ben shall acquire one heroic copy of Marvel/);
  assert.match(source.content, /contracts-channel\/contract-message/);
  assert.equal(source.channelId, "contracts-channel");
  assert.deepEqual(source.sourceChannelIds, ["contracts-channel"]);
  assert.equal(source.authorId, "requester");
});

test("put this in memory resolves replied-to content instead of command wording", async () => {
  const invocation = {
    guildId: "guild-1",
    channelId: "channel-1",
    reference: { messageId: "source" },
    fetchReference: async () => ({
      content: "The actual record to preserve",
      url: "https://discord.com/channels/guild-1/channel-1/source",
      channelId: "channel-1",
      author: { id: "user-2", bot: false },
    }),
  };
  const source = await sourceText(
    invocation as never,
    "Put this in long-term memory, please",
    {} as never,
    "requester",
    () => true,
  );
  assert.equal(source.content, "The actual record to preserve");
});
