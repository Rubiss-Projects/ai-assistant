import assert from "node:assert/strict";
import test from "node:test";
import { MessageFlags, MessagePayload } from "discord.js";
import { discordTextOptions } from "../src/common/discordResponse.js";
import { deliverMentionResponse } from "../src/handlers/mention.js";
import { handleAsk } from "../src/handlers/slash/ask.js";
import { handleChat } from "../src/handlers/slash/chat.js";
import { handleHistory } from "../src/handlers/slash/history.js";
import { chunkForDiscord } from "../src/common/chunkForDiscord.js";

const links = "https://example.com/one\n[Second link](https://example.org/two)";
const longAnswer = `${links}\n${"a".repeat(2000)}\n${links}`;
const attachment = { data: Buffer.from("download"), displayName: "result.txt" };
const response = { content: longAnswer, attachments: [attachment] };

test.beforeEach(t => {
  const previous = process.env.DISCORD_SUPPRESS_EMBEDS;
  delete process.env.DISCORD_SUPPRESS_EMBEDS;
  t.after(() => {
    if (previous === undefined) delete process.env.DISCORD_SUPPRESS_EMBEDS;
    else process.env.DISCORD_SUPPRESS_EMBEDS = previous;
  });
});

test("link previews remain enabled by default and when disabled explicitly", () => {
  for (const value of [undefined, "false", "", "0"]) {
    if (value === undefined) delete process.env.DISCORD_SUPPRESS_EMBEDS;
    else process.env.DISCORD_SUPPRESS_EMBEDS = value;
    assert.deepEqual(discordTextOptions(links), { content: links, files: [] });
  }
});

test("the Discord payload suppresses embeds without rewriting links or suppressing notifications", () => {
  process.env.DISCORD_SUPPRESS_EMBEDS = " TRUE ";
  const target = { client: { options: { allowedMentions: { parse: ["users", "roles", "everyone"] } } } };
  const { body } = new MessagePayload(target as never, discordTextOptions(links)).resolveBody();
  assert.equal(body!.content, links);
  assert.equal(body!.flags, MessageFlags.SuppressEmbeds);
  assert.deepEqual(body!.allowed_mentions, target.client.options.allowedMentions);
});

function deliveryMock() {
  const sent: ReturnType<typeof discordTextOptions>[] = [];
  const message = {
    edit: async (options: any) => { if (typeof options === "object") sent.push(options); return message; },
    reply: async (options: any) => { sent.push(options); return message; },
  };
  return { sent, message };
}

function assertDelivered(sent: ReturnType<typeof discordTextOptions>[]) {
  const chunks = chunkForDiscord(longAnswer);
  assert.deepEqual(sent.slice(0, chunks.length), chunks.map(content => ({ content, files: [], flags: MessageFlags.SuppressEmbeds })));
  assert.deepEqual(sent[chunks.length], {
    content: "📎 `result.txt`", files: [{ attachment: attachment.data, name: attachment.displayName }],
  });
  assert.equal(sent.length, chunks.length + 1);
}

for (const mode of ["direct", "progress", "failed edit", "failed overflow"]) {
  test(`mentions suppress previews on every chunk: ${mode}`, async () => {
    process.env.DISCORD_SUPPRESS_EMBEDS = "true";
    const { sent, message } = deliveryMock();
    const progress = mode === "direct" ? undefined : {
      edit: mode === "failed edit" ? async () => { throw new Error("Missing progress message"); } : message.edit,
      reply: mode === "failed overflow" ? async () => { throw new Error("Reply unavailable"); } : message.reply,
    };
    await deliverMentionResponse(message as never, progress as never, response);
    assertDelivered(sent);
  });
}

for (const mode of ["ask", "chat DM", "chat thread", "chat new thread"]) {
  test(`${mode} suppresses all response chunks and preserves attachment delivery`, async () => {
    process.env.DISCORD_SUPPRESS_EMBEDS = "true";
    const { sent, message } = deliveryMock();
    const thread = { id: "thread", send: message.reply, toString: () => "<#thread>" };
    let loading = false;
    const interaction = {
      user: { id: "user", send: async () => message }, client: { user: { id: "bot" } }, channelId: "channel",
      channel: { isDMBased: () => mode === "chat DM", isThread: () => mode === "chat thread" },
      options: { getString: (key: string) => key === "workspace" ? null : "Tell me about these sites", getAttachment: () => null },
      deferReply: async () => { loading = true; }, fetchReply: async () => ({ ...message, startThread: async () => thread }),
      editReply: async () => { loading = false; },
    };
    const sessions = { sendMessage: async () => response, resetSession: async () => {}, activeProviderDisplayName: () => "Codex" };
    if (mode === "ask") await handleAsk(interaction as never, sessions as never);
    else await handleChat(interaction as never, sessions as never);
    if (mode !== "ask") assert.equal(loading, false, "clear Discord loading through the interaction webhook before durable message edits");
    assertDelivered(sent);
  });
}

test("history suppresses previews on the private edit and follow-ups", async () => {
  process.env.DISCORD_SUPPRESS_EMBEDS = "true";
  const sent: any[] = [];
  const interaction = {
    user: { id: "user" }, channelId: "channel", channel: { isDMBased: () => true, isThread: () => false },
    options: { getInteger: () => 5 }, deferReply: async () => {},
    editReply: async (options: any) => { sent.push(options); },
    followUp: async (options: any) => { sent.push(options); },
  };
  const sessions = { getHistory: async () => [{ type: "assistant.message", data: { content: longAnswer } }], activeProviderDisplayName: () => "Codex" };
  await handleHistory(interaction as never, sessions as never);
  assert.ok(sent.length > 1);
  assert.deepEqual(sent.map(options => options.content), chunkForDiscord(`**Codex:** ${longAnswer}`));
  for (const options of sent) assert.equal(options.flags, MessageFlags.SuppressEmbeds);
  for (const options of sent.slice(1)) assert.equal(options.ephemeral, true);
});
