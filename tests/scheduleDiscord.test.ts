import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import { DiscordScheduleAdapter } from "../src/scheduling/discordAdapter.js";
import type { ScheduledTask, TaskRun } from "../src/scheduling/types.js";
import type { SessionManager } from "../src/sessionManager.js";
import type { SendMessageOptions } from "../src/providers/types.js";

const task: ScheduledTask = { id: "task", ownerId: "100", guildId: "200", channelId: "300", kind: "ai", content: "Summarize discussion",
  cron: "0 9 * * *", timezone: "UTC", contextMessages: 10, enabled: true, nextRunAt: 0, revision: 1, createdAt: 0, provider: "codex", model: "model", reasoning: "low" };
const run: TaskRun = { id: "run", taskId: "task", channelId: "300", taskRevision: 1, occurrence: "0", startedAt: 0, state: "running", parts: [], messageIds: [] };
function discordMock() {
  const denied = new Set<string>();
  const sent: any[] = [];
  const member = (id: string) => ({ id, roles: { cache: new Map() } });
  const guild = { members: { fetch: async (input: { user: string }) => member(input.user), fetchMe: async () => member("bot") } };
  const channel = {
    type: ChannelType.GuildText, guildId: "200", guild,
    permissionsFor: (member: { id: string }) => ({ has: (_bits: bigint[]) => !denied.has(member.id) }),
    messages: { fetch: async () => new Map([
      ["1", { author: { id: "101", bot: false }, content: "Visible discussion", createdTimestamp: 1, createdAt: new Date(1) }],
      ["2", { author: { id: "102", bot: false }, content: "Excluded author", createdTimestamp: 2, createdAt: new Date(2) }],
      ["3", { author: { id: "bot", bot: true }, content: "Old AI output", createdTimestamp: 3, createdAt: new Date(3) }],
    ]) },
    send: async (options: any) => { sent.push(options); return { id: "message-id" }; },
  };
  const client = { channels: { fetch: async () => channel }, guilds: { fetch: async () => guild } } as unknown as Client;
  return { client, channel, denied, sent };
}

test("Discord scheduler checks owner, bot, actor, and channel type", async () => {
  const f = discordMock();
  const adapter = new DiscordScheduleAdapter(f.client, createAccessPolicy({ DISCORD_ADMIN_USERS: "100" }), {} as SessionManager);
  await adapter.authorize(task);
  for (const who of ["100", "bot", "actor"]) {
    f.denied.add(who);
    await assert.rejects(adapter.authorize(task, "actor"), /access/);
    f.denied.clear();
  }
  f.channel.guildId = "201";
  await assert.rejects(adapter.authorize(task), /text channel/);
  f.channel.guildId = "200";
  f.channel.type = ChannelType.PrivateThread;
  await assert.rejects(adapter.authorize(task), /text channel/);
});

test("scheduled sends suppress mentions and use a stable nonce", async () => {
  const f = discordMock();
  const adapter = new DiscordScheduleAdapter(f.client, createAccessPolicy({}), {} as SessionManager);
  const part = { content: "@everyone <@100>" };
  await adapter.send(task, part, "run:0");
  await adapter.send(task, part, "run:0");
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(f.sent[0].nonce, f.sent[1].nonce);
  assert.equal(f.sent[0].enforceNonce, true);
});

test("AI scheduling isolates sessions and workspaces, filters context, binds lookups, and forwards timeout", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-ai-"));
  const oldMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const oldRoot = process.env.AI_ASSISTANT_WORKSPACE_ROOT;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = root;
  t.after(() => {
    if (oldMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE; else process.env.AI_ASSISTANT_SECURITY_MODE = oldMode;
    if (oldRoot === undefined) delete process.env.AI_ASSISTANT_WORKSPACE_ROOT; else process.env.AI_ASSISTANT_WORKSPACE_ROOT = oldRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = discordMock();
  const keys: string[] = []; const workspaces: string[] = []; const settings: string[] = [];
  const sessions = {
    setSessionProvider: async (_key: string, provider: string) => { settings.push(provider); },
    setSessionWorkingDir: (_key: string, dir: string) => { workspaces.push(dir); },
    setModel: async (_key: string, model: string) => { settings.push(model); },
    setReasoningEffort: async (_key: string, effort: string) => { settings.push(effort); },
    sendMessage: async (key: string, prompt: string, _files: unknown, options: SendMessageOptions) => {
      keys.push(key);
      assert.equal(options.timeoutMs, 1234);
      assert.match(prompt, /Visible discussion/);
      assert.doesNotMatch(prompt, /Excluded author|Old AI output/);
      await assert.rejects(options.resolveArtifactMessage!("https://discord.com/channels/200/999/1"), /destination channel/);
      return { content: "Summary", attachments: [] };
    },
    forgetSession: async () => {},
  } as unknown as SessionManager;
  const adapter = new DiscordScheduleAdapter(f.client, createAccessPolicy({ DISCORD_ADMIN_USERS: "100", DISCORD_ALLOWED_USERS: "100,101" }), sessions);
  assert.deepEqual(await adapter.generate(task, run, 1234), [{ content: "Summary" }]);
  await adapter.generate(task, { ...run, id: "next" }, 1234);
  assert.notEqual(keys[0], keys[1]);
  assert.notEqual(workspaces[0], workspaces[1]);
  assert.equal(fs.existsSync(workspaces[0]), false);
  assert.deepEqual(settings, ["codex", "model", "low", "codex", "model", "low"]);
});

test("fixed messages never invoke a provider", async () => {
  const f = discordMock();
  const adapter = new DiscordScheduleAdapter(f.client, createAccessPolicy({}), {} as SessionManager);
  assert.deepEqual(await adapter.generate({ ...task, kind: "message", content: "Exact text", contextMessages: 0 }, run, 1), [{ content: "Exact text" }]);
});

test("a task change during channel fetch is checked immediately before sending", async () => {
  const f = discordMock();
  const adapter = new DiscordScheduleAdapter(f.client, createAccessPolicy({}), {} as SessionManager);
  await assert.rejects(adapter.send(task, { content: "Stale output" }, "run:0", () => { throw new Error("Task changed"); }), /Task changed/);
  assert.equal(f.sent.length, 0);
});
