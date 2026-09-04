import assert from "node:assert/strict";
import test from "node:test";
import { deliverMentionResponse } from "../src/handlers/mention.js";
import { chunkForDiscord } from "../src/sessionManager.js";

type DiscordOptions = { content: string; files: unknown[] };
const textResponse = (content: string) => ({ content, attachments: [] });

test("mention response replaces the progress message", async () => {
  const sourceReplies: DiscordOptions[] = [];
  const edits: DiscordOptions[] = [];
  const overflowReplies: DiscordOptions[] = [];
  const sourceMessage = {
    reply: async (options: DiscordOptions) => {
      sourceReplies.push(options);
      return {};
    },
  };
  const progressReply = {
    edit: async (options: DiscordOptions) => {
      edits.push(options);
      return {};
    },
    reply: async (options: DiscordOptions) => {
      overflowReplies.push(options);
      return {};
    },
  };

  await deliverMentionResponse(sourceMessage as never, progressReply as never, textResponse("Final answer"));

  assert.deepEqual(edits, [{ content: "Final answer", files: [] }]);
  assert.deepEqual(sourceReplies, []);
  assert.deepEqual(overflowReplies, []);
});

test("mention response sends overflow only after editing the progress message", async () => {
  const edits: DiscordOptions[] = [];
  const overflowReplies: DiscordOptions[] = [];
  const progressReply = {
    edit: async (options: DiscordOptions) => {
      edits.push(options);
      return {};
    },
    reply: async (options: DiscordOptions) => {
      overflowReplies.push(options);
      return {};
    },
  };

  await deliverMentionResponse({ reply: async () => ({}) } as never, progressReply as never, textResponse("a".repeat(2_001)));

  assert.equal(edits.length, 1);
  assert.equal(overflowReplies.length, 1);
  assert.equal(edits[0].content.length + overflowReplies[0].content.length, 2_001);
});

test("mention response falls back to a new reply when the progress edit fails", async () => {
  const sourceReplies: DiscordOptions[] = [];

  await deliverMentionResponse(
    { reply: async (options: DiscordOptions) => { sourceReplies.push(options); return {}; } } as never,
    {
      edit: async () => { throw new Error("missing message"); },
      reply: async () => ({}),
    } as never,
    textResponse("Final answer"),
  );

  assert.deepEqual(sourceReplies, [{ content: "Final answer", files: [] }]);
});

test("mention response retries only unsent overflow chunks", async () => {
  const edits: DiscordOptions[] = [];
  const overflowReplies: DiscordOptions[] = [];
  const sourceReplies: DiscordOptions[] = [];
  let overflowAttempts = 0;
  const response = `${"a".repeat(2_000)}\n${"b".repeat(2_000)}\n${"c".repeat(2_000)}`;
  const chunks = chunkForDiscord(response);

  await deliverMentionResponse(
    { reply: async (options: DiscordOptions) => { sourceReplies.push(options); return {}; } } as never,
    {
      edit: async (options: DiscordOptions) => { edits.push(options); return {}; },
      reply: async (options: DiscordOptions) => {
        overflowAttempts += 1;
        if (overflowAttempts === 2) throw new Error("send failed");
        overflowReplies.push(options);
        return {};
      },
    } as never,
    textResponse(response),
  );

  assert.deepEqual(edits, [{ content: chunks[0], files: [] }]);
  assert.deepEqual(overflowReplies, [{ content: chunks[1], files: [] }]);
  assert.deepEqual(sourceReplies, chunks.slice(2).map((content) => ({ content, files: [] })));
});

test("mention response sends artifacts separately after all text chunks", async () => {
  const edits: DiscordOptions[] = [];
  const overflowReplies: DiscordOptions[] = [];
  const attachment = { data: Buffer.from("patch"), displayName: "changes.patch" };

  await deliverMentionResponse(
    { reply: async () => ({}) } as never,
    {
      edit: async (options: DiscordOptions) => { edits.push(options); return {}; },
      reply: async (options: DiscordOptions) => { overflowReplies.push(options); return {}; },
    } as never,
    { content: "a".repeat(2_001), attachments: [attachment] },
  );

  assert.deepEqual(edits[0].files, []);
  assert.deepEqual(overflowReplies[0].files, []);
  assert.deepEqual(overflowReplies[1], {
    content: "📎 `changes.patch`",
    files: [{ attachment: attachment.data, name: "changes.patch" }],
  });
});

test("mention response preserves text and reports an attachment upload failure", async () => {
  const edits: DiscordOptions[] = [];
  const replies: DiscordOptions[] = [];
  const attachment = { data: Buffer.from("patch"), displayName: "changes.patch" };

  await deliverMentionResponse(
    { reply: async () => ({}) } as never,
    {
      edit: async (options: DiscordOptions) => { edits.push(options); return {}; },
      reply: async (options: DiscordOptions) => {
        if (options.files.length) throw new Error("Discord rejected upload");
        replies.push(options);
        return {};
      },
    } as never,
    { content: "Final answer", attachments: [attachment] },
  );

  assert.deepEqual(edits, [{ content: "Final answer", files: [] }]);
  assert.match(replies[0].content, /Could not upload.*changes\.patch/);
});

test("mention response never uploads byte-identical attachments twice", async () => {
  const replies: DiscordOptions[] = [];
  const data = Buffer.from("same image");

  await deliverMentionResponse(
    { reply: async () => ({}) } as never,
    {
      edit: async () => ({}),
      reply: async (options: DiscordOptions) => { replies.push(options); return {}; },
    } as never,
    {
      content: "Done.",
      attachments: [
        { data, displayName: "copied.png" },
        { data: Buffer.from(data), displayName: "generated-image-1.png" },
      ],
    },
  );

  assert.equal(replies.length, 1);
  assert.equal((replies[0].files[0] as { name: string }).name, "copied.png");
});
