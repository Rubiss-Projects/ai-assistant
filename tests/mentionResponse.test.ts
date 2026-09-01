import assert from "node:assert/strict";
import test from "node:test";
import { deliverMentionResponse } from "../src/handlers/mention.js";
import { chunkForDiscord } from "../src/sessionManager.js";

test("mention response replaces the progress message", async () => {
  const sourceReplies: string[] = [];
  const edits: string[] = [];
  const overflowReplies: string[] = [];
  const sourceMessage = {
    reply: async (content: string) => {
      sourceReplies.push(content);
      return {};
    },
  };
  const progressReply = {
    edit: async (content: string) => {
      edits.push(content);
      return {};
    },
    reply: async (content: string) => {
      overflowReplies.push(content);
      return {};
    },
  };

  await deliverMentionResponse(sourceMessage as never, progressReply as never, "Final answer");

  assert.deepEqual(edits, ["Final answer"]);
  assert.deepEqual(sourceReplies, []);
  assert.deepEqual(overflowReplies, []);
});

test("mention response sends overflow only after editing the progress message", async () => {
  const edits: string[] = [];
  const overflowReplies: string[] = [];
  const progressReply = {
    edit: async (content: string) => {
      edits.push(content);
      return {};
    },
    reply: async (content: string) => {
      overflowReplies.push(content);
      return {};
    },
  };

  await deliverMentionResponse({ reply: async () => ({}) } as never, progressReply as never, "a".repeat(2_001));

  assert.equal(edits.length, 1);
  assert.equal(overflowReplies.length, 1);
  assert.equal(edits[0].length + overflowReplies[0].length, 2_001);
});

test("mention response falls back to a new reply when the progress edit fails", async () => {
  const sourceReplies: string[] = [];

  await deliverMentionResponse(
    { reply: async (content: string) => { sourceReplies.push(content); return {}; } } as never,
    {
      edit: async () => { throw new Error("missing message"); },
      reply: async () => ({}),
    } as never,
    "Final answer",
  );

  assert.deepEqual(sourceReplies, ["Final answer"]);
});

test("mention response retries only unsent overflow chunks", async () => {
  const edits: string[] = [];
  const overflowReplies: string[] = [];
  const sourceReplies: string[] = [];
  let overflowAttempts = 0;
  const response = `${"a".repeat(2_000)}\n${"b".repeat(2_000)}\n${"c".repeat(2_000)}`;
  const chunks = chunkForDiscord(response);

  await deliverMentionResponse(
    { reply: async (content: string) => { sourceReplies.push(content); return {}; } } as never,
    {
      edit: async (content: string) => { edits.push(content); return {}; },
      reply: async (content: string) => {
        overflowAttempts += 1;
        if (overflowAttempts === 2) throw new Error("send failed");
        overflowReplies.push(content);
        return {};
      },
    } as never,
    response,
  );

  assert.deepEqual(edits, [chunks[0]]);
  assert.deepEqual(overflowReplies, [chunks[1]]);
  assert.deepEqual(sourceReplies, chunks.slice(2));
});
