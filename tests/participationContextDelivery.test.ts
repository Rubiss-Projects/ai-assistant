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

test("an unmentioned follow-up receives earlier images as native inputs and cleans them up", async t => {
  const { participationContext, participationReplyContext, participationAttachments } = await import("../src/common/discordParticipation.js");
  const { readFile, access } = await import("node:fs/promises");
  t.mock.method(DiscordMemoryStore.prototype, "all", () => []);
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const attachment = { url: "https://cdn.discordapp.com/attachments/chart.png", name: "chart.png", contentType: "image/png", size: png.length };
  const history = {
    id: "1", channelId: "thread", content: "Our usage so far", createdTimestamp: 1,
    author: { id: "alice", username: "Alice", bot: false }, attachments: new Map([["image", attachment]]),
  };
  const blocked = { ...history, id: "2", author: { id: "blocked", username: "Blocked", bot: false },
    attachments: new Map([["secret", { ...attachment, url: "https://cdn.discordapp.com/secret.png" }]]) };
  const message = {
    id: "3", guildId: "test", channelId: "thread", content: "Explain that chart", createdTimestamp: 3,
    author: { id: "alice", username: "Alice", bot: false }, attachments: new Map(), mentions: { has: () => false },
    channel: { messages: { fetch: async () => new Map([[history.id, history], [blocked.id, blocked]]) },
      permissionsFor: () => ({ has: () => true }) }, reply: async () => {},
  };
  const context = await participationContext([message as never], "bot", id => id !== "blocked");
  const downloads: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    downloads.push(url); return new Response(png);
  });
  let imagePath = "";
  const sessions = { sendMessage: async (_key: string, prompt: string, attachments: Array<{ path: string; kind: string }>) => {
    assert.match(prompt, /Our usage so far/);
    assert.match(prompt, /chart.png/);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].kind, "image");
    imagePath = attachments[0].path;
    assert.deepEqual(await readFile(imagePath), png);
    return { content: "Here is the chart explanation", attachments: [] };
  } };
  await handleMention(message as never, { user: { id: "bot" } } as never, sessions as never, "thread", id => id !== "blocked", {
    context: participationReplyContext(context, [message.id]), requests: [message as never], attachments: participationAttachments(context),
  });
  assert.deepEqual(downloads, [attachment.url]);
  assert.ok(imagePath);
  await assert.rejects(access(imagePath), { code: "ENOENT" });

  message.channel.permissionsFor = () => ({ has: () => false });
  const deniedContext = await participationContext([message as never], "bot", () => true);
  assert.deepEqual(participationAttachments(deniedContext), []);
});
