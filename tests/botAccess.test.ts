import assert from "node:assert/strict";
import test from "node:test";
import {
  canInvokeSlashCommand,
  createAccessPolicy,
  slashCommandRequiresAdmin,
} from "../src/bot.js";

test("empty access lists allow messages and slash commands", () => {
  const access = createAccessPolicy({});

  assert.equal(access.canMessage("user-1"), true);
  assert.equal(access.canUseAdminCommands("user-1"), true);
});

test("slash commands fall back to the normal allowlist", () => {
  const access = createAccessPolicy({ DISCORD_ALLOWED_USERS: "user-1, user-2" });

  assert.equal(access.canMessage("user-1"), true);
  assert.equal(access.canUseAdminCommands("user-1"), true);
  assert.equal(access.canMessage("user-3"), false);
  assert.equal(access.canUseAdminCommands("user-3"), false);
});

test("admin list independently restricts slash commands", () => {
  const access = createAccessPolicy({
    DISCORD_ALLOWED_USERS: "user-1,user-2",
    DISCORD_ADMIN_USERS: "user-2, user-3",
  });

  assert.equal(access.canMessage("user-1"), true);
  assert.equal(access.canUseAdminCommands("user-1"), false);
  assert.equal(access.canMessage("user-2"), true);
  assert.equal(access.canUseAdminCommands("user-2"), true);
  assert.equal(access.canMessage("user-3"), false);
  assert.equal(access.canUseAdminCommands("user-3"), true);
});

test("an empty admin list still falls back to allowed users", () => {
  const access = createAccessPolicy({
    DISCORD_ALLOWED_USERS: "user-1",
    DISCORD_ADMIN_USERS: " , ",
  });

  assert.equal(access.canUseAdminCommands("user-1"), true);
  assert.equal(access.canUseAdminCommands("user-2"), false);
});

test("read-only and conversation slash actions are public", () => {
  for (const request of [
    { commandName: "ask" },
    { commandName: "chat" },
    { commandName: "reset" },
    { commandName: "history" },
    { commandName: "compact" },
    { commandName: "plan", subcommand: "update" },
    { commandName: "model", subcommand: "list" },
    { commandName: "model", subcommand: "current" },
    { commandName: "reasoning", subcommand: "list" },
    { commandName: "provider", subcommand: "current" },
    { commandName: "agent", subcommand: "list" },
    { commandName: "mode", subcommand: "get" },
  ]) {
    assert.equal(slashCommandRequiresAdmin(request), false, JSON.stringify(request));
  }
});

test("configuration, infrastructure, and explicit workspace actions require admin", () => {
  for (const request of [
    { commandName: "servers" },
    { commandName: "leave" },
    { commandName: "status" },
    { commandName: "fleet" },
    { commandName: "workspace" },
    { commandName: "mcp", subcommand: "list" },
    { commandName: "model", subcommand: "set" },
    { commandName: "reasoning", subcommand: "set" },
    { commandName: "provider", subcommand: "set" },
    { commandName: "agent", subcommand: "select" },
    { commandName: "agent", subcommand: "deselect" },
    { commandName: "mode", subcommand: "set" },
    { commandName: "ask", hasWorkspace: true },
    { commandName: "chat", hasWorkspace: true },
    { commandName: "future-command" },
  ]) {
    assert.equal(slashCommandRequiresAdmin(request), true, JSON.stringify(request));
  }
});

test("allowed users get public actions while admins get every action", () => {
  const access = createAccessPolicy({
    DISCORD_ALLOWED_USERS: "member",
    DISCORD_ADMIN_USERS: "admin",
  });

  assert.equal(canInvokeSlashCommand(access, "member", { commandName: "ask" }), true);
  assert.equal(canInvokeSlashCommand(access, "member", { commandName: "model", subcommand: "set" }), false);
  assert.equal(canInvokeSlashCommand(access, "admin", { commandName: "model", subcommand: "set" }), true);
  assert.equal(canInvokeSlashCommand(access, "admin", { commandName: "ask" }), true);
  assert.equal(canInvokeSlashCommand(access, "stranger", { commandName: "ask" }), false);
});
