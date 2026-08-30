import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscordMemoryStore } from "../src/common/discordMemoryStore.js";

test("DiscordMemoryStore persists server-scoped memories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-memory-"));
  const file = path.join(dir, "memories.json");
  const memory = {
    id: "one",
    guildId: "guild-a",
    channelId: "channel-a",
    authorId: "user-a",
    content: "Dave owes Sam a wheel of cheese",
    sourceUrl: "https://discord.com/channels/guild-a/channel-a/message-a",
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  new DiscordMemoryStore(file).add(memory);
  const restored = new DiscordMemoryStore(file);
  assert.deepEqual(restored.all("guild-a"), [memory]);
  assert.deepEqual(restored.all("guild-b"), []);
  assert.equal(restored.delete(new Set(["one"])), 1);
  assert.deepEqual(new DiscordMemoryStore(file).all("guild-a"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
