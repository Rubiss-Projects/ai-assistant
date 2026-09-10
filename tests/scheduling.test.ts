import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccessPolicy, parseGrants, slashCommandCapability } from "../src/common/accessPolicy.js";
import { nextOccurrences, validateSchedule } from "../src/scheduling/cron.js";
import { ScheduleStore } from "../src/scheduling/store.js";
import { Scheduler, ScheduleAccessError, DeliveryRejectedError, type ScheduleAdapter } from "../src/scheduling/engine.js";
import { RunTimeoutError } from "../src/providers/types.js";
import { providerTimeout } from "../src/common/runLifecycle.js";
import { commands } from "../src/commands.js";
import type { ScheduledTask } from "../src/scheduling/types.js";

const admin = { userId: "100", guildId: "200" };
const input = { guildId: "200", channelId: "300", kind: "message" as const, content: "Reminder", cron: "0 * * * *", timezone: "UTC", contextMessages: 0 };
const limits = { minimumMs: 60_000, maxOwner: 2, maxGuild: 3, concurrency: 2, timeoutMs: 1000 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: { after(fn: () => Promise<void>): void }, adapter: Partial<ScheduleAdapter> = {}) {
  let now = Date.UTC(2026, 0, 1);
  const store = new ScheduleStore(":memory:");
  const sent: string[] = [];
  const scheduler = new Scheduler(store, createAccessPolicy({ DISCORD_ADMIN_USERS: "100" }), {
    authorize: async () => {}, generate: async task => [{ content: task.content }],
    send: async (_task, part) => { sent.push(part.content); return String(sent.length); }, ...adapter,
  }, limits, () => now);
  scheduler.start();
  t.after(() => scheduler.stop());
  return { scheduler, store, sent, advance(ms: number) { now += ms; store.renew(now - ms); /* Short jumps in these tests. */ }, setTime(value: number) { now = value; }, now: () => now };
}

test("schedule rights never inherit legacy open-admin fallback", () => {
  const policy = createAccessPolicy({});
  assert.equal(policy.canUseAdminCommands("100"), true);
  for (const capability of ["schedule.message.create", "schedule.ai.create", "schedule.manage.own", "schedule.manage.guild"] as const) {
    assert.equal(policy.can(admin, capability), false);
  }
  const explicit = createAccessPolicy({ DISCORD_ADMIN_USERS: "100" });
  assert.equal(explicit.can(admin, "schedule.ai.create"), true);
  assert.equal(explicit.can(admin, "schedule.manage.guild", { guildId: "999" }), false);
});

test("role grants are guild scoped, AI remains trusted-admin only, own resources stay owned", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rights.json");
  fs.writeFileSync(file, JSON.stringify({ grants: [{ guildId: "200", roleId: "400", roles: ["scheduler"], capabilities: ["schedule.ai.create"] }] }));
  const policy = createAccessPolicy({ DISCORD_RIGHTS_FILE: file, DISCORD_ALLOWED_USERS: "999", DISCORD_ADMIN_USERS: "999" });
  const user = { userId: "101", guildId: "200", roleIds: ["400"] };
  assert.equal(policy.can(user, "schedule.message.create"), true);
  assert.equal(policy.canMessage("101", user), true);
  assert.equal(policy.can({ ...user, guildId: "201" }, "schedule.message.create"), false);
  assert.equal(policy.can({ ...user, roleIds: [] }, "schedule.message.create"), false);
  assert.equal(policy.can(user, "schedule.ai.create"), false);
  assert.equal(policy.can(user, "schedule.manage.own", { guildId: "200", ownerId: "102" }), false);
  assert.equal(policy.can(user, "bot.manage"), false);
});

test("malformed and overbroad rights fail closed", () => {
  for (const grants of [[{ roleId: "123" }], [{ userId: "123", guildId: "200", roles: ["bot-admin"] }],
    [{ userId: "123", roles: ["typo"] }], [{ userId: "123", capabilities: ["schedule.typo"] }], [{ userId: "123", roleId: "456", guildId: "200" }]]) {
    assert.throws(() => parseGrants({ grants }));
  }
  assert.throws(() => createAccessPolicy({ DISCORD_RIGHTS_FILE: "/nonexistent/rights.json" }));
  assert.equal(slashCommandCapability({ commandName: "future" }), undefined);
});

test("cron validates format, timezone, frequency and weekday local time across DST", () => {
  assert.throws(() => nextOccurrences("* * * * * *", "UTC"));
  assert.throws(() => nextOccurrences("0 9 * * *", "not/a-zone"));
  assert.throws(() => validateSchedule("* * * * *", "UTC", 900_000));
  const dates = nextOccurrences("0 9 * * 1-5", "America/New_York", Date.UTC(2026, 2, 6, 0), 2);
  assert.deepEqual(dates.map(d => new Date(d).toISOString()), ["2026-03-06T14:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
});

test("all registered slash command payloads serialize", () => {
  const serialized = commands.map(command => command.toJSON());
  assert.equal(serialized.filter(command => command.name === "schedule").length, 1);
  for (const command of serialized.filter(c => c.name !== "schedule")) {
    const subs = command.options?.filter(option => option.type === 1) ?? [];
    for (const request of subs.length ? subs.map(sub => ({ commandName: command.name, subcommand: sub.name })) : [{ commandName: command.name }]) {
      assert.ok(slashCommandCapability(request), JSON.stringify(request));
    }
  }
});

test("fixed message runs persist delivery IDs and cannot immediately rerun", async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, input);
  const runId = f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Reminder"]);
  assert.equal(f.store.getRun(runId)?.state, "succeeded");
  assert.deepEqual(f.store.getRun(runId)?.messageIds, ["1"]);
  assert.throws(() => f.scheduler.runNow(admin, task.id), /minimum run interval/);
});

test("task quotas count paused schedules and scope ownership", async t => {
  const f = fixture(t);
  const first = await f.scheduler.create(admin, input);
  f.scheduler.pause(admin, first.id);
  await f.scheduler.create(admin, input);
  await assert.rejects(f.scheduler.create(admin, input), /limit reached/);
  assert.throws(() => f.scheduler.requireTask({ userId: "101", guildId: "200" }, first.id), /unavailable/);
  assert.throws(() => f.scheduler.requireTask({ ...admin, guildId: "201" }, first.id), /unavailable/);
});

test("pause during generation suppresses pending output", async t => {
  const gate = deferred();
  const f = fixture(t, { generate: async () => { await gate.promise; return [{ content: "Late" }]; } });
  const task = await f.scheduler.create(admin, input);
  const id = f.scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  f.scheduler.pause(admin, task.id);
  gate.resolve();
  await f.scheduler.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.getRun(id)?.state, "cancelled");
});

test("edit during generation suppresses stale output without pausing the new revision", async t => {
  const gate = deferred();
  const f = fixture(t, { generate: async () => { await gate.promise; return [{ content: "Old" }]; } });
  const task = await f.scheduler.create(admin, input);
  f.scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  await f.scheduler.edit(admin, task.id, { content: "New" });
  gate.resolve();
  await f.scheduler.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get(task.id)?.enabled, true);
  assert.equal(f.store.get(task.id)?.content, "New");
});

test("revoked authorization before delivery pauses without sending", async t => {
  let authorized = true;
  const f = fixture(t, { authorize: async () => { if (!authorized) throw new ScheduleAccessError("Revoked"); },
    generate: async () => { authorized = false; return [{ content: "Private" }]; } });
  const task = await f.scheduler.create(admin, input);
  f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get(task.id)?.pauseReason, "Revoked");
});

test("definitely rejected delivery retries only the unsent parts without new generation", async t => {
  let generated = 0; let sends = 0; let reject = true;
  const f = fixture(t, { generate: async () => { generated++; return [{ content: "A" }, { content: "B" }]; },
    send: async () => { sends++; if (sends === 2 && reject) throw new DeliveryRejectedError("Rejected"); return String(sends); } });
  const task = await f.scheduler.create(admin, input);
  const id = f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(id)?.state, "delivery_failed");
  reject = false;
  f.scheduler.retryDelivery(admin, task.id, id);
  await f.scheduler.idle();
  assert.equal(generated, 1);
  assert.equal(sends, 3);
  assert.deepEqual(f.store.getRun(id)?.messageIds, ["1", "3"]);
});

test("uncertain sends are never automatically retried and pause the task", async t => {
  const f = fixture(t, { send: async () => { throw new Error("connection reset after send"); } });
  const task = await f.scheduler.create(admin, input);
  const id = f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(id)?.state, "uncertain");
  assert.equal(f.store.get(task.id)?.enabled, false);
  assert.throws(() => f.scheduler.retryDelivery(admin, task.id, id), /Uncertain sends/);
});

test("unconfirmed AI cancellation pauses future execution", async t => {
  const f = fixture(t, { generate: async () => { throw new RunTimeoutError("test", 1000, false); } });
  const task = await f.scheduler.create(admin, { ...input, kind: "ai", provider: "codex", model: "test" });
  const id = f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(id)?.state, "uncertain");
  assert.equal(f.store.get(task.id)?.enabled, false);
});

test("database survives restart, skips missed schedules and fences a second worker", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedules-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "schedules.sqlite");
  const now = Date.UTC(2026, 0, 1);
  const first = new ScheduleStore(file);
  first.acquire(now);
  const second = new ScheduleStore(file);
  assert.throws(() => second.acquire(now + 1), /Another scheduler/);
  const task: ScheduledTask = { ...input, id: "task", ownerId: "100", revision: 1, createdAt: now, nextRunAt: now, enabled: true };
  first.save(task);
  assert.ok(first.claim(task.id, now, 60_000));
  assert.equal(first.claim(task.id, now, 60_000), undefined);
  second.acquire(now + 60_001);
  assert.throws(() => first.assertLease(now + 60_001), /lease lost/);
  second.recover(now + 60_001);
  assert.equal(second.get(task.id)?.enabled, false);
  assert.equal(second.runs(task.id)[0].state, "uncertain");
  second.save({ ...task, id: "missed", nextRunAt: now });
  second.recover(now + 60_001);
  assert.equal(second.get("missed")?.nextRunAt, now + 3_600_000);
  first.close(); second.close();
  const third = new ScheduleStore(file);
  assert.equal(third.runs(task.id)[0].state, "uncertain");
  third.close();
});

test("host timeout can only shorten provider timeout", () => {
  assert.equal(providerTimeout("TEST_MISSING_TIMEOUT", { timeoutMs: 1234 }), 1234);
  assert.equal(providerTimeout("TEST_MISSING_TIMEOUT", { timeoutMs: 9_000_000 }), 3_600_000);
  assert.throws(() => providerTimeout("TEST_MISSING_TIMEOUT", { timeoutMs: NaN }));
});

test("restart preserves generated output for explicit delivery retry", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ready-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ScheduleStore(path.join(dir, "db.sqlite"));
  t.after(() => store.close());
  const now = Date.UTC(2026, 0, 1);
  store.acquire(now);
  store.save({ ...input, id: "task", ownerId: "100", revision: 1, createdAt: now, nextRunAt: now, enabled: true });
  const { run } = store.claim("task", now, 60_000)!;
  run.state = "ready";
  run.parts = [{ content: "Already generated" }];
  store.saveRun(run);
  store.recover(now + 1);
  assert.equal(store.getRun(run.id)?.state, "delivery_failed");
  assert.deepEqual(store.getRun(run.id)?.parts, [{ content: "Already generated" }]);
  assert.equal(store.get("task")?.enabled, true);
  assert.equal(store.get("task")?.revision, 1);
});

test("context author policy retains guild-scoped user and role grants", async t => {
  const { contextAuthorPolicy } = await import("../src/common/discordAccess.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rights.json");
  fs.writeFileSync(file, JSON.stringify({ grants: [
    { userId: "101", guildId: "200", roles: ["member"] },
    { roleId: "400", guildId: "200", roles: ["member"] },
  ] }));
  const policy = createAccessPolicy({ DISCORD_ALLOWED_USERS: "100", DISCORD_ADMIN_USERS: "100", DISCORD_RIGHTS_FILE: file });
  const client = { guilds: { cache: new Map([["200", { members: { cache: new Map([["102", { roles: { cache: new Map([["400", {}]]) } }]]) } }]]) } };
  const filter = contextAuthorPolicy(policy, client as any, "200");
  assert.equal(filter("101"), true);
  assert.equal(filter("102"), true);
  assert.equal(filter("103"), false);
  assert.equal(contextAuthorPolicy(policy, client as any, "201")("101"), false);
});

test("repeated rejected deliveries cannot accumulate unbounded saved payloads", t => {
  const store = new ScheduleStore(":memory:");
  t.after(() => store.close());
  const now = Date.UTC(2026, 0, 1);
  store.acquire(now);
  store.save({ ...input, id: "task", ownerId: "100", revision: 1, createdAt: now, nextRunAt: now, enabled: true });
  let firstId = "";
  for (let i = 0; i < 25; i++) {
    const { run } = store.claim("task", now + i * 1000, 1, true)!;
    if (!firstId) firstId = run.id;
    run.state = "delivery_failed";
    run.parts = [{ content: "Saved result" }];
    store.saveRun(run);
  }
  assert.equal(store.runs("task").length, 20);
  assert.equal(store.getRun(firstId), undefined);
});

test("shared mode rejects rights files writable through provider workspaces", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "protected-rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace);
  const inside = path.join(workspace, "rights.json");
  const outside = path.join(dir, "rights.json");
  fs.writeFileSync(inside, '{"grants":[]}');
  fs.writeFileSync(outside, '{"grants":[]}');
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: workspace };
  assert.throws(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: inside }), /outside the provider workspace/);
  const linkIn = path.join(dir, "link-in.json");
  const linkOut = path.join(workspace, "link-out.json");
  fs.symlinkSync(inside, linkIn);
  fs.symlinkSync(outside, linkOut);
  assert.throws(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: linkIn }), /outside the provider workspace/);
  assert.throws(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: linkOut }), /outside the provider workspace/);
  assert.doesNotThrow(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: outside }));
});

test("a raw bot.manage grant does not confer administrator or unrelated capabilities", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-management-rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rights.json");
  fs.writeFileSync(file, JSON.stringify({ grants: [{ userId: "101", capabilities: ["bot.manage"] }] }));
  const policy = createAccessPolicy({ DISCORD_ALLOWED_USERS: "100", DISCORD_ADMIN_USERS: "100", DISCORD_RIGHTS_FILE: file });
  const subject = { userId: "101", guildId: "200" };
  assert.equal(policy.can(subject, "bot.manage"), true);
  assert.equal(policy.isExplicitAdmin(subject), false);
  assert.equal(policy.canUseAdminCommands("101"), false);
  for (const capability of ["workspace.manage", "mcp.manage", "session.configure", "schedule.ai.create", "schedule.message.create", "schedule.manage.guild"] as const) {
    assert.equal(policy.can(subject, capability), false, capability);
  }
});

test("graceful shutdown drains a claimed run and leaves its recurring schedule enabled", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draining-schedule-"));
  const file = path.join(dir, "schedules.sqlite");
  const store = new ScheduleStore(file);
  const gate = deferred();
  const sent: string[] = [];
  const scheduler = new Scheduler(store, createAccessPolicy({ DISCORD_ADMIN_USERS: "100" }), {
    authorize: async () => {},
    generate: async () => { await gate.promise; return [{ content: "Completed during shutdown" }]; },
    send: async (_task, part, _nonce, beforeSend) => { beforeSend(); sent.push(part.content); return "message-id"; },
  }, limits);
  scheduler.start();
  t.after(async () => { gate.resolve(); await scheduler.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const task = await scheduler.create(admin, input);
  const runId = scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  const stopping = scheduler.stop();
  assert.throws(() => scheduler.runNow(admin, task.id), /not running/);
  gate.resolve();
  await stopping;
  assert.deepEqual(sent, ["Completed during shutdown"]);
  const reopened = new ScheduleStore(file);
  assert.equal(reopened.get(task.id)?.enabled, true);
  assert.equal(reopened.getRun(runId)?.state, "succeeded");
  assert.deepEqual(reopened.getRun(runId)?.messageIds, ["message-id"]);
  reopened.close();
});
