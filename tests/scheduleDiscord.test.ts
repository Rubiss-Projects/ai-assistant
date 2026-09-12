import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, MessageFlags, PermissionFlagsBits, type Client } from "discord.js";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import { DiscordScheduleAdapter } from "../src/scheduling/discordAdapter.js";
import type { ScheduledTask, TaskRun } from "../src/scheduling/types.js";
import type { SessionManager } from "../src/sessionManager.js";
import type { SendMessageOptions } from "../src/providers/types.js";
import { describeTask, handleSchedule } from "../src/handlers/slash/schedule.js";

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

test("schedule descriptions show the cutoff and only occurrences strictly before it", () => {
  const now = Date.UTC(2026, 0, 1);
  const endAt = now + 2 * 3_600_000;
  const hourly = { ...task, cron: "0 * * * *", endAt };
  const description = describeTask(hourly, now);
  assert.match(description, /— enabled/);
  assert.ok(description.includes(`Ends: <t:${endAt / 1000}:F>`));
  const preview = description.split("Next occurrences:")[1];
  assert.ok(preview.includes(`<t:${(now + 3_600_000) / 1000}:F>`));
  assert.ok(!preview.includes(`<t:${endAt / 1000}:F>`));
  assert.match(describeTask(hourly, endAt), /— ended/);
  assert.match(describeTask(hourly, endAt), /None within the schedule dates/);
  assert.doesNotMatch(describeTask({ ...hourly, enabled: false }, endAt), /if resumed/);
  assert.match(describeTask({ ...hourly, endAt: now + 1000 }, now), /None within the schedule dates/);
  assert.match(describeTask({ ...hourly, endAt: undefined }, now), /No end date/);
});

test("previews begin at the inclusive start and distinguish scheduled tasks from paused tasks", () => {
  const now = Date.UTC(2026, 0, 1);
  const startAt = now + 2 * 3_600_000;
  const scheduled = { ...task, cron: "0 * * * *", startAt, endAt: startAt + 3_600_000 };
  const description = describeTask(scheduled, now);
  assert.match(description, /— scheduled/);
  assert.ok(description.includes(`Starts: <t:${startAt / 1000}:F>`));
  const preview = description.split("Next occurrences:")[1];
  assert.ok(preview.includes(`<t:${startAt / 1000}:F>`));
  assert.ok(!preview.includes(`<t:${(startAt - 3_600_000) / 1000}:F>`));
  assert.match(describeTask(scheduled, startAt), /— enabled/);
  assert.match(describeTask({ ...scheduled, enabled: false }, now), /— paused/);
});

for (const field of ["start", "end"] as const) test(`schedule commands parse, change, preserve and clear ${field} dates using the effective timezone`, async () => {
  const property = field === "start" ? "startAt" : "endAt";
  for (const [sub, values, expected] of [
    ["create", { [`${field}_at`]: "2026-12-01 18:30", timezone: "America/New_York" }, Date.UTC(2026, 11, 1, 23, 30)],
    ["edit", { [`${field}_at`]: "2026-12-01 18:30" }, Date.UTC(2026, 11, 1, 23, 30)],
    ["edit", { [`${field}_at`]: "2026-12-01 18:30", timezone: "UTC" }, Date.UTC(2026, 11, 1, 18, 30)],
    ["edit", { [`${field}_at`]: "2026-12-01T18:30:00.000+02:00" }, Date.UTC(2026, 11, 1, 16, 30)],
    ["edit", { [`${field}_at`]: " NoNe " }, undefined],
    ["edit", { content: "Updated" }, "preserved"],
  ] as const) {
    let saved: any;
    const replies: string[] = [];
    const existing = { ...task, timezone: "America/New_York", startAt: Date.UTC(2026, 11, 1), endAt: Date.UTC(2026, 11, 31) };
    const options: Record<string, string> = sub === "create"
      ? { kind: "message", content: "Reminder", cron: "0 * * * *", ...values }
      : { id: task.id, ...values };
    const interaction = {
      deferReply: async () => {}, editReply: async ({ content }: { content: string }) => { replies.push(content); }, followUp: async () => {},
      options: { getSubcommand: () => sub, getString: (key: string) => options[key] ?? null, getChannel: () => sub === "create" ? { id: "300" } : null, getInteger: () => null },
    };
    const scheduler = {
      assertAvailable: () => {}, requireTask: () => existing,
      create: async (_subject: unknown, input: any) => { saved = input; return { ...existing, ...input }; },
      edit: async (_subject: unknown, _id: string, patch: any) => { saved = patch; return { ...existing, ...patch }; },
    };
    await handleSchedule(interaction as any, scheduler as any, { userId: "100", guildId: "200" });
    assert.ok(saved, replies.join("\n"));
    if (expected === "preserved") assert.equal(Object.hasOwn(saved, property), false);
    else { assert.equal(Object.hasOwn(saved, property), true); assert.equal(saved[property], expected); }
  }
});

test("schedule list marks elapsed tasks ended before a scheduler tick", async () => {
  const replies: string[] = [];
  const endedTask = { ...task, endAt: Date.now() - 1000 };
  const interaction = {
    deferReply: async () => {}, editReply: async ({ content }: { content: string }) => { replies.push(content); }, followUp: async () => {},
    options: { getSubcommand: () => "list" },
  };
  const scheduler = { assertAvailable: () => {}, canManage: () => true, store: { list: () => [endedTask] } };
  await handleSchedule(interaction as any, scheduler as any, { userId: "100", guildId: "200" });
  assert.match(replies.join("\n"), /· ended ·/);
  assert.match(replies.join("\n"), /Ends: <t:/);
});

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

for (const kind of ["message", "ai"] as const) test(`${kind} scheduled sends allow mentions and use a stable nonce`, async () => {
  const f = discordMock();
  const adapter = new DiscordScheduleAdapter(f.client, createAccessPolicy({}), {} as SessionManager);
  const part = { content: "@everyone @here <@100> <@&400>" };
  await adapter.send({ ...task, kind }, part, "run:0");
  await adapter.send({ ...task, kind }, part, "run:0");
  assert.equal(f.sent[0].content, part.content);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: ["users", "roles", "everyone"], repliedUser: false });
  assert.equal(f.sent[0].nonce, f.sent[1].nonce);
  assert.equal(f.sent[0].enforceNonce, true);
});

for (const kind of ["message", "ai"] as const) test(`${kind} schedules honor the embed setting without changing mentions or attachments`, async t => {
  const previous = process.env.DISCORD_SUPPRESS_EMBEDS;
  t.after(() => {
    if (previous === undefined) delete process.env.DISCORD_SUPPRESS_EMBEDS;
    else process.env.DISCORD_SUPPRESS_EMBEDS = previous;
  });
  const f = discordMock();
  const adapter = new DiscordScheduleAdapter(f.client, createAccessPolicy({}), {} as SessionManager);
  const part = { content: "@everyone https://example.com/one https://example.org/two", attachment: { base64: Buffer.from("file").toString("base64"), name: "result.txt" } };
  for (const enabled of [false, true]) {
    process.env.DISCORD_SUPPRESS_EMBEDS = String(enabled);
    await adapter.send({ ...task, kind }, part, "run:0");
    const sent = f.sent.at(-1);
    assert.equal(sent.flags, enabled ? MessageFlags.SuppressEmbeds : undefined);
    assert.equal(sent.content, part.content);
    assert.deepEqual(sent.files, [{ attachment: Buffer.from("file"), name: "result.txt" }]);
    assert.deepEqual(sent.allowedMentions, { parse: ["users", "roles", "everyone"], repliedUser: false });
    assert.equal(sent.enforceNonce, true);
  }
  assert.equal(f.sent[0].nonce, f.sent[1].nonce);
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

test("AI schedule creation accepts the same default-provider configuration as the session manager", async t => {
  const { handleSchedule } = await import("../src/handlers/slash/schedule.js");
  const oldProvider = process.env.PROVIDER;
  t.after(() => { if (oldProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = oldProvider; });
  for (const [configured, expected] of [[undefined, "copilot"], ["", "copilot"], ["   ", "copilot"], [" CoDeX ", "codex"], ["OpenCode", "opencode"]]) {
    if (configured === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = configured;
    let saved: any;
    const replies: string[] = [];
    const values: Record<string, string> = { kind: "ai", model: "test-model", content: "Prompt", cron: "0 9 * * *", timezone: "UTC" };
    const interaction = {
      deferReply: async () => {}, editReply: async ({ content }: { content: string }) => { replies.push(content); }, followUp: async () => {},
      options: { getSubcommand: () => "create", getString: (key: string) => values[key] ?? null, getChannel: () => ({ id: "300" }), getInteger: () => null },
    };
    const scheduler = { assertAvailable: () => {}, create: async (_subject: unknown, input: any) => {
      saved = input; return { ...task, ...input };
    } };
    await handleSchedule(interaction as any, scheduler as any, { userId: "100", guildId: "200" });
    assert.equal(saved?.provider, expected, `${JSON.stringify(configured)}: ${replies.join("\n")}`);
  }
});
