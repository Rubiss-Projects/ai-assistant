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

test("mention response attaches artifacts only to the first Discord message", async () => {
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

  assert.deepEqual(edits[0].files, [{ attachment: attachment.data, name: "changes.patch" }]);
  assert.deepEqual(overflowReplies[0].files, []);
});
