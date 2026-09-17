import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Events } from "discord.js";
import { createBot } from "../src/bot.js";

test.beforeEach(t => {
  const keys = ["AI_ASSISTANT_SECURITY_MODE", "DISCORD_ADMIN_USERS", "DISCORD_ALLOWED_USERS", "DISCORD_RIGHTS_FILE", "SCHEDULES_ENABLED"];
  const saved = keys.map(key => process.env[key]);
  keys.forEach(key => { delete process.env[key]; });
  process.env.SCHEDULES_ENABLED = "false";
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  }));
});

function harness() {
  const runs: string[] = [];
  const sent: unknown[] = [];
  const message = { edit: async (value: unknown) => { sent.push(value); }, reply: async () => {} };
  const thread = { id: "thread", send: async (value: unknown) => { sent.push(value); }, toString: () => "<#thread>" };
  const sessions = {
    sendMessage: async (key: string) => { runs.push(key); return { content: "answer", attachments: [] }; },
    resetSession: async () => {}, activeProviderDisplayName: () => "Test",
  };
  const client = createBot(sessions as never);
  function interaction(commandName: string, guildId: string | null, userId = "member") {
    const replies: { content: string }[] = [];
    let dmCount = 0;
    return {
      commandName, guildId, replies, get dmCount() { return dmCount; },
      isChatInputCommand: () => true,
      user: { id: userId, send: async () => { dmCount++; return message; } },
      client: { user: { id: "bot" } }, channelId: "channel",
      channel: { isDMBased: () => !guildId, isThread: () => false },
      options: { getSubcommand: () => null, getString: (key: string) => key === "workspace" ? null : "hello", getAttachment: () => null },
      reply: async (value: { content: string }) => { replies.push(value); },
      deferReply: async () => {}, editReply: async () => {},
      fetchReply: async () => ({ ...message, startThread: async () => thread }),
    };
  }
  const dispatch = async (value: unknown) => {
    await (client.listeners(Events.InteractionCreate)[0] as (value: unknown) => Promise<void>)(value);
  };
  return { client, interaction, dispatch, runs, sent };
}

test("shared mode denies member /ask even with open-admin fallback, but allows public /chat", async t => {
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  const h = harness();
  t.after(() => h.client.destroy());
  const ask = h.interaction("ask", "guild");
  await h.dispatch(ask);
  assert.match(ask.replies[0].content, /restricted.*administrators/);
  assert.equal(ask.dmCount, 0);
  assert.deepEqual(h.runs, []);
  await h.dispatch(h.interaction("chat", "guild"));
  assert.deepEqual(h.runs, ["thread"]);
  assert.ok(h.sent.some(value => typeof value === "object" && value !== null && "content" in value && value.content === "answer"));
});

test("shared mode allows explicit admins /ask in a server but rejects every DM slash command", async t => {
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.DISCORD_ADMIN_USERS = "admin";
  const h = harness();
  t.after(() => h.client.destroy());
  const ask = h.interaction("ask", "guild", "admin");
  await h.dispatch(ask);
  assert.equal(ask.dmCount, 1);
  assert.equal(h.runs.length, 1);
  for (const user of ["member", "admin"]) {
    for (const command of ["ask", "chat", "schedule", "reset"]) {
      const dm = h.interaction(command, null, user);
      await h.dispatch(dm);
      assert.match(dm.replies[0].content, /DMs are disabled/);
      assert.equal(dm.dmCount, 0);
    }
  }
  assert.equal(h.runs.length, 1);
});

test("shared mode ignores incoming DMs before accessing message contents or running AI", async t => {
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  const h = harness();
  t.after(() => h.client.destroy());
  await (h.client.listeners(Events.MessageCreate)[0] as (value: unknown) => Promise<void>)({
    guildId: null,
    get author() { throw new Error("DM must be rejected before processing"); },
  });
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.sent, []);
});

test("shared mode recognizes global bot-admin grants but not Discord Administrator permission", async t => {
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-visibility-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DISCORD_RIGHTS_FILE = path.join(dir, "rights.json");
  fs.writeFileSync(process.env.DISCORD_RIGHTS_FILE, JSON.stringify({ grants: [{ userId: "123", roles: ["bot-admin"] }] }));
  const h = harness();
  t.after(() => h.client.destroy());
  const admin = h.interaction("ask", "guild", "123");
  await h.dispatch(admin);
  assert.equal(admin.dmCount, 1);
  const member = { ...h.interaction("ask", "guild"), memberPermissions: { has: () => true } };
  await h.dispatch(member);
  assert.match(member.replies[0].content, /restricted.*administrators/);
  assert.equal(h.runs.length, 1);
});

test("unrestricted mode retains /ask and DM /chat", async t => {
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  const h = harness();
  t.after(() => h.client.destroy());
  const ask = h.interaction("ask", "guild");
  await h.dispatch(ask);
  assert.equal(ask.dmCount, 1);
  await h.dispatch(h.interaction("chat", null));
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1], "member");
});
