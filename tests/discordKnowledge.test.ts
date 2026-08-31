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
      id: "summary",
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
        messages: [[
          {
            id: "later-expanded-copy",
            channel_id: "discussion-channel",
            content: `${contract}\nLater commentary that must not become the canonical record.`,
            author: { id: "helper", bot: true, username: "Helper" },
            timestamp: "2026-02-01T00:00:00.000Z",
          },
          {
            id: "summary-copy",
            channel_id: "summary-channel",
            content: "CONTRACT-BEN-MARVEL-2026-A and CONTRACT-OTHER were discussed in this summary.",
            author: { id: "helper", bot: true, username: "Helper" },
            timestamp: "2026-01-15T00:00:00.000Z",
          },
          {
            id: "contract-message",
            channel_id: "contracts-channel",
            content: contract,
            author: { id: "assistant", bot: true, username: "AI Assistant" },
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ]],
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
  assert.doesNotMatch(source.content, /OTHER were discussed/);
  assert.doesNotMatch(source.content, /Later commentary/);
  assert.match(source.content, /contracts-channel\/contract-message/);
  assert.equal(source.channelId, "contracts-channel");
  assert.deepEqual(source.sourceChannelIds, ["contracts-channel"]);
  assert.equal(source.authorId, "requester");
});

test("substantive text beginning with a demonstrative remains explicit memory", async () => {
  const source = await sourceText(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      reference: { messageId: "unrelated" },
      fetchReference: async () => ({
        content: "Unrelated replied-to content",
        channelId: "channel-1",
        author: { id: "user-2", bot: false },
      }),
    } as never,
    "Remember that this deployment uses blue-green",
    {} as never,
    "requester",
    () => true,
  );
  assert.equal(source.content, "this deployment uses blue-green");
});

test("substantive facts containing in-memory wording remain intact", async () => {
  const source = await sourceText(
    { guildId: "guild-1", channelId: "channel-1" } as never,
    "Remember that caching in memory reduces latency",
    {} as never,
    "requester",
    () => true,
  );
  assert.equal(source.content, "caching in memory reduces latency");
});

test("destination-first memory wording stores only the substantive fact", async () => {
  const source = await sourceText(
    { guildId: "guild-1", channelId: "channel-1" } as never,
    "Commit to memory that launch is Tuesday",
    {} as never,
    "requester",
    () => true,
  );
  assert.equal(source.content, "launch is Tuesday");
});

test("facts ending in a memory location are not mistaken for destinations", async () => {
  const source = await sourceText(
    { guildId: "guild-1", channelId: "channel-1" } as never,
    "Record that the CPU writes state to memory",
    {} as never,
    "requester",
    () => true,
  );
  assert.equal(source.content, "the CPU writes state to memory");
});

test("over-limit contract summaries are retained instead of partially resolved", async () => {
  const content = Array.from({ length: 11 }, (_, index) => `CONTRACT-${index + 1}`).join(" ");
  const source = await sourceText({
    guildId: "guild-1",
    channelId: "summary-channel",
    reference: { messageId: "summary" },
    fetchReference: async () => ({ id: "summary", content, channelId: "summary-channel", author: { id: "assistant", bot: true } }),
  } as never, "Commit these contracts to memory", { user: { id: "assistant" } } as never, "requester", () => true);
  assert.equal(source.content, content);
});

test("an incomplete multi-contract lookup retains the replied-to summary", async () => {
  const invocation = {
    guildId: "guild-1",
    channelId: "summary-channel",
    reference: { messageId: "summary" },
    fetchReference: async () => ({
      id: "summary",
      content: "Active: CONTRACT-ONE and CONTRACT-TWO",
      url: "https://discord.com/channels/guild-1/summary-channel/summary",
      channelId: "summary-channel",
      author: { id: "assistant", bot: true },
    }),
  };
  const client = {
    user: { id: "assistant" },
    rest: { get: async (_route: unknown, options: { query: URLSearchParams }) => ({
      total_results: options.query.get("content") === "CONTRACT-ONE" ? 1 : 0,
      messages: options.query.get("content") === "CONTRACT-ONE" ? [[{
        id: "contract-one",
        channel_id: "contracts-channel",
        content: "CONTRACT-ONE\nFirst contract text",
        author: { id: "assistant", bot: true, username: "AI Assistant" },
        timestamp: "2026-01-01T00:00:00.000Z",
      }]] : [],
    }) },
    channels: { fetch: async () => ({
      isDMBased: () => false,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
    }) },
  };
  const source = await sourceText(invocation as never, "Commit these contracts to memory", client as never, "requester", () => true);
  assert.equal(source.content, "Active: CONTRACT-ONE and CONTRACT-TWO");
  assert.equal(source.channelId, "summary-channel");
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
