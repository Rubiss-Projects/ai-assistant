import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { artifactMessageResolver } from "../src/utils/artifactMessage.js";

function mockClient(allowed = true, type = ChannelType.GuildText) {
  let reads = 0;
  const client = {
    user: { id: "bot" },
    channels: { fetch: async () => ({
      guildId: "1", type, isDMBased: () => type === ChannelType.DM, recipientId: "requester",
      guild: { members: { fetch: async () => ({ id: "requester" }) } },
      permissionsFor: () => ({ has: (permissions: unknown) => permissions === PermissionFlagsBits.ManageThreads ? false : allowed }),
      members: { fetch: async () => { throw new Error("Not a member"); } },
      messages: { fetch: async () => { reads++; return {
        author: { id: "author" }, content: "Try https://example.com/video.mp4",
        attachments: new Map([["a", { url: "https://cdn.discordapp.com/image.png", name: "image.png", size: 100, contentType: "image/png" }]]),
        embeds: [{ video: { url: "https://example.com/video.mp4" }, image: { url: "https://example.com/preview.png" }, fields: [] }],
      }; } },
    }) },
  };
  return { client, reads: () => reads };
}

test("Discord lookup extracts uploads, message URLs, and embed media without duplicates", async () => {
  const { client } = mockClient();
  const result = await artifactMessageResolver(client as never, "requester")("https://discord.com/channels/1/2/3");
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].name, "image.png");
  assert.ok(result.candidates.every((candidate) => candidate.sourceMessage === "https://discord.com/channels/1/2/3"));
});

test("Discord lookup rejects inaccessible channels, private threads, mismatched servers, and excluded authors", async () => {
  const denied = mockClient(false);
  await assert.rejects(artifactMessageResolver(denied.client as never, "requester")("https://discord.com/channels/1/2/3"), /permission/);
  assert.equal(denied.reads(), 0);
  const privateThread = mockClient(true, ChannelType.PrivateThread);
  await assert.rejects(artifactMessageResolver(privateThread.client as never, "requester")("https://discord.com/channels/1/2/3"), /member/);
  assert.equal(privateThread.reads(), 0);
  const mismatch = mockClient();
  await assert.rejects(artifactMessageResolver(mismatch.client as never, "requester")("https://discord.com/channels/9/2/3"), /server/);
  assert.equal(mismatch.reads(), 0);
  await assert.rejects(artifactMessageResolver(mismatch.client as never, "requester", () => false)("https://discord.com/channels/1/2/3"), /context policy/);
});

test("Discord DM lookup is limited to the requester's own bot conversation", async () => {
  const { client } = mockClient(true, ChannelType.DM);
  const url = "https://discord.com/channels/@me/2/3";
  assert.equal((await artifactMessageResolver(client as never, "requester")(url)).candidates.length, 3);
  await assert.rejects(artifactMessageResolver(client as never, "another-user")(url), /cannot read/);
});
