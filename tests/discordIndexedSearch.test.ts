import assert from "node:assert/strict";
import test from "node:test";
import { enrichWithDiscordKnowledge } from "../src/utils/discordKnowledge.js";

test("uses AI-planned Discord indexed searches and deduplicates results", async () => {
  const calls: Array<{ route: string; query: URLSearchParams }> = [];
  const apiMessage = {
    id: "message-1",
    channel_id: "channel-1",
    author: { id: "author-1", username: "Sam", global_name: "Sam", bot: false },
    content: "We agreed to use the cabin for the beach weekend.",
    timestamp: "2026-08-01T12:00:00.000Z",
  };
  const client = {
    rest: {
      get: async (route: string, options: { query: URLSearchParams }) => {
        calls.push({ route, query: options.query });
        return { doing_deep_historical_index: false, total_results: 1, messages: [[apiMessage]] };
      },
    },
    channels: {
      fetch: async () => ({
        isDMBased: () => false,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
      }),
    },
  };
  const invocation = {
    guildId: "guild-1",
    channelId: "channel-1",
    channel: { id: "channel-1" },
    user: { id: "requester-1" },
  };
  let inferenceCalls = 0;
  const infer = async () => {
    inferenceCalls += 1;
    return '{"queries":["beach lodging","cabin weekend"]}';
  };

  const enriched = await enrichWithDiscordKnowledge(
    invocation as never,
    "Search this channel for what we decided about beach accommodations",
    client as never,
    () => true,
    infer,
  );

  assert.equal(inferenceCalls, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].route, /\/guilds\/guild-1\/messages\/search$/);
  assert.equal(calls[0].query.get("content"), "beach lodging");
  assert.deepEqual(calls[0].query.getAll("channel_id"), ["channel-1"]);
  assert.match(enriched, /We agreed to use the cabin/);
  assert.match(enriched, /discord\.com\/channels\/guild-1\/channel-1\/message-1/);
  assert.equal(enriched.match(/We agreed to use the cabin/g)?.length, 1);
});

test("server-wide language omits the current-channel filter", async () => {
  let query: URLSearchParams | undefined;
  const client = {
    rest: { get: async (_route: string, options: { query: URLSearchParams }) => {
      query = options.query;
      return { doing_deep_historical_index: false, total_results: 0, messages: [] };
    } },
    channels: { fetch: async () => null },
  };
  const invocation = {
    guildId: "guild-1",
    channelId: "channel-1",
    channel: { id: "channel-1" },
    user: { id: "requester-1" },
  };

  await enrichWithDiscordKnowledge(
    invocation as never,
    "Search across the server for the launch plan",
    client as never,
    () => true,
    async () => '{"queries":["launch plan"]}',
  );

  assert.ok(query);
  assert.deepEqual(query.getAll("channel_id"), []);
});
