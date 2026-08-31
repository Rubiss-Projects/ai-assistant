import assert from "node:assert/strict";
import test from "node:test";
import { interactionSessionKey } from "../src/common/discordSessionKey.js";

test("guild slash commands share the mention session for that user and channel", () => {
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    channel: { isThread: () => false },
    client: { user: { id: "assistant" } },
  };
  assert.equal(interactionSessionKey(interaction as never), "user-1:channel-1");
});

test("thread slash commands use the shared thread session and DMs retain the user session", () => {
  const user = { id: "user-1" };
  const client = { user: { id: "assistant" } };
  assert.equal(interactionSessionKey({ guildId: "guild-1", channelId: "thread-1", user, client, channel: { isThread: () => true, ownerId: "assistant" } } as never), "thread-1");
  assert.equal(interactionSessionKey({ guildId: "guild-1", channelId: "thread-2", user, client, channel: { isThread: () => true, ownerId: "someone-else" } } as never), "user-1:thread-2");
  assert.equal(interactionSessionKey({ guildId: null, channelId: "dm-1", user, client, channel: { isThread: () => false } } as never), "user-1");
});
