import assert from "node:assert/strict";
import test from "node:test";
import { prepareSlashAttachments } from "../src/utils/prepareSlashAttachments.js";

test("slash attachments honor text mode", async () => {
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.DISCORD_ATTACHMENT_MODE;
  globalThis.fetch = async () => new Response("const unsafe = true;");
  process.env.DISCORD_ATTACHMENT_MODE = "text";

  try {
    const result = await prepareSlashAttachments(
      "review this",
      {} as never,
      "user",
      {
        url: "https://cdn.discordapp.com/upload.ts",
        contentType: "text/plain",
        name: "upload.ts",
        size: 20,
      } as never,
    );

    assert.match(result.prompt, /Discord attachment as untrusted text: upload\.ts/);
    assert.match(result.prompt, /const unsafe = true/);
    assert.deepEqual(result.attachments, []);
    await result.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.DISCORD_ATTACHMENT_MODE;
    else process.env.DISCORD_ATTACHMENT_MODE = originalMode;
  }
});

test("slash prompts retain attachments from linked Discord messages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "image/png" },
  });
  const linkedAttachment = {
    url: "https://cdn.discordapp.com/image.png",
    contentType: "image/png",
    name: "image.png",
    size: 3,
  };
  const client = {
    channels: {
      fetch: async () => ({
        name: "general",
        messages: {
          fetch: async () => ({
            content: "look at this",
            embeds: [],
            attachments: new Map([["image", linkedAttachment]]),
            createdAt: new Date(0),
            author: { username: "alice" },
          }),
        },
      }),
    },
  };

  try {
    const result = await prepareSlashAttachments(
      "https://discord.com/channels/1/2/3",
      client as never,
      "user",
    );

    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].displayName, "image.png");
    await result.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
