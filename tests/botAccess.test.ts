import assert from "node:assert/strict";
import test from "node:test";
import { createAccessPolicy } from "../src/bot.js";

test("empty access lists allow messages and slash commands", () => {
  const access = createAccessPolicy({});

  assert.equal(access.canMessage("user-1"), true);
  assert.equal(access.canUseSlashCommands("user-1"), true);
});

test("slash commands fall back to the normal allowlist", () => {
  const access = createAccessPolicy({ DISCORD_ALLOWED_USERS: "user-1, user-2" });

  assert.equal(access.canMessage("user-1"), true);
  assert.equal(access.canUseSlashCommands("user-1"), true);
  assert.equal(access.canMessage("user-3"), false);
  assert.equal(access.canUseSlashCommands("user-3"), false);
});

test("admin list independently restricts slash commands", () => {
  const access = createAccessPolicy({
    DISCORD_ALLOWED_USERS: "user-1,user-2",
    DISCORD_ADMIN_USERS: "user-2, user-3",
  });

  assert.equal(access.canMessage("user-1"), true);
  assert.equal(access.canUseSlashCommands("user-1"), false);
  assert.equal(access.canMessage("user-2"), true);
  assert.equal(access.canUseSlashCommands("user-2"), true);
  assert.equal(access.canMessage("user-3"), false);
  assert.equal(access.canUseSlashCommands("user-3"), true);
});

test("an empty admin list still falls back to allowed users", () => {
  const access = createAccessPolicy({
    DISCORD_ALLOWED_USERS: "user-1",
    DISCORD_ADMIN_USERS: " , ",
  });

  assert.equal(access.canUseSlashCommands("user-1"), true);
  assert.equal(access.canUseSlashCommands("user-2"), false);
});
