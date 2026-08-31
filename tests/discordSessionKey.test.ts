import assert from "node:assert/strict";
import test from "node:test";
import { interactionSessionKey } from "../src/common/discordSessionKey.js";

test("guild slash commands share the mention session for that user and channel", () => {
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    channel: { isThread: () => false },
  };
  assert.equal(interactionSessionKey(interaction as never), "user-1:channel-1");
});

test("thread slash commands use the shared thread session and DMs retain the user session", () => {
  const user = { id: "user-1" };
  assert.equal(interactionSessionKey({ guildId: "guild-1", channelId: "thread-1", user, channel: { isThread: () => true } } as never), "thread-1");
  assert.equal(interactionSessionKey({ guildId: null, channelId: "dm-1", user, channel: { isThread: () => false } } as never), "user-1");
});
