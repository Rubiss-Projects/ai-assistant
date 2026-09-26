import { enrichDiscordRequest } from "../src/utils/discordKnowledge.js";
import assert from "node:assert/strict";
import test from "node:test";
import { handleMention } from "../src/handlers/mention.js";
import { handleChat } from "../src/handlers/slash/chat.js";
import { prepareSlashAttachments } from "../src/utils/prepareSlashAttachments.js";

const attachment = { url: "https://cdn.discordapp.com/history.txt", name: "history.txt", contentType: "text/plain", size: 10 };
function fixture() {
  let ambientReads = 0;
  const channel = {
    id: "2", guildId: "1", isDMBased: () => false, isThread: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => { ambientReads++; throw new Error("Unexpected ambient history fetch"); } },
  };
  const client = { user: { id: "bot" }, channels: { fetch: async () => channel }, rest: { get: async () => [] } };
  const sent: string[] = [];
  const sessions = { sendMessage: async (_key, prompt, attachments) => {
    assert.equal(attachments, undefined);
    sent.push(prompt);
    return { content: "No messages", attachments: [] };
  } };
  return { channel, client, sessions, sent, ambientReads: () => ambientReads };
}

for (const prompt of ["summarize the last 50 messages", "summarize messages on 2026-09-20"]) {
  test(`mention summary skips reply and participation attachments: ${prompt}`, async () => {
    const f = fixture();
    const message = { id: "2000", guildId: "1", channelId: "2", channel: f.channel,
      content: `<@bot> ${prompt}`, author: { id: "user", username: "user" },
      createdTimestamp: Date.now(), attachments: new Map(), reference: { messageId: "1999" },
      mentions: { has: () => true }, reply: async () => ({}) };
    await handleMention(message as never, f.client as never, f.sessions as never, undefined, undefined, {
      participation: { context: "AMBIENT HISTORY", requests: [{ attachments: new Map([["file", attachment]]) } as never], attachments: [attachment] },
    });
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /Channel summary/);
    assert.doesNotMatch(f.sent[0], /AMBIENT HISTORY|history.txt/);
    assert.equal(f.ambientReads(), 0);
  });

  test(`slash summary suppresses supplied history attachments: ${prompt}`, async () => {
    const f = fixture();
    const interaction = { id: "2000", guildId: "1", channelId: "2", user: { id: "user" }, createdTimestamp: Date.now() };
    const prepared = await prepareSlashAttachments(prompt, f.client as never, "user", null, interaction as never, undefined, undefined, [attachment]);
    try {
      assert.equal(prepared.isChannelSummary, true);
      assert.deepEqual(prepared.attachments, []);
      assert.doesNotMatch(prepared.prompt, /history.txt/);
    } finally { await prepared.cleanup(); }
  });
}

test("thread chat does not reintroduce ambient context after summary preparation", async () => {
  const f = fixture();
  const durable = { id: "2001", edit: async () => ({}), reply: async () => ({}) };
  const interaction = { id: "2000", guildId: "1", channelId: "2", channel: f.channel, client: f.client,
    user: { id: "user", username: "user" }, createdTimestamp: Date.now(),
    options: { getString: name => name === "message" ? "summarize messages" : null, getAttachment: () => null },
    deferReply: async () => {}, editReply: async () => {}, fetchReply: async () => durable };
  await handleChat(interaction as never, f.sessions as never, undefined, undefined, async () => [
    { id: "1999", authorId: "friend", content: "AMBIENT HISTORY", attachments: [attachment] } as never,
  ]);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.sent[0], /AMBIENT HISTORY|history.txt/);
});


test("DM summary enrichment preserves the prompt and ordinary conversation metadata", async () => {
  const prompt = "summarize this conversation";
  for (const source of [
    { guildId: null, author: { id: "user" } },
    { guildId: null, user: { id: "user" } },
  ]) {
    const result = await enrichDiscordRequest(source as never, prompt, {} as never);
    assert.deepEqual(result, { prompt, isChannelSummary: false });
  }
});
