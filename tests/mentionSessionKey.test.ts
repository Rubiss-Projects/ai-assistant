import assert from "node:assert/strict";
import test from "node:test";
import { mentionSessionKey } from "../src/handlers/mention.js";

test("guild mentions isolate a user's provider session by channel", () => {
  const author = { id: "user-1" };
  assert.equal(mentionSessionKey({ guildId: "guild-1", channelId: "channel-a", author } as never), "user-1:channel-a");
  assert.equal(mentionSessionKey({ guildId: "guild-1", channelId: "channel-b", author } as never), "user-1:channel-b");
});

test("DM mentions retain the user's session", () => {
  assert.equal(mentionSessionKey({ guildId: null, channelId: "dm-1", author: { id: "user-1" } } as never), "user-1");
});
