import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import { ScheduleStore } from "../src/scheduling/store.js";
import { Scheduler, ScheduleAccessError, type ScheduleAdapter } from "../src/scheduling/engine.js";
import type { ScheduledTask, TaskRun } from "../src/scheduling/types.js";

const now = Date.UTC(2026, 0, 1);
const admin = { userId: "100", guildId: "200" };
const access = createAccessPolicy({ DISCORD_ADMIN_USERS: "100" });
const limits = { minimumMs: 60_000, maxOwner: 10, maxGuild: 10, concurrency: 2, timeoutMs: 1000 };
const task: ScheduledTask = { id: "task", ownerId: "100", guildId: "200", channelId: "300", kind: "ai",
  provider: "codex", model: "test", content: "Reminder", cron: "0 * * * *", timezone: "UTC",
  contextMessages: 0, enabled: true, revision: 1, createdAt: now, nextRunAt: now };
const adapter: ScheduleAdapter = { authorize: async () => {}, generate: async () => [{ content: "Recovered" }],
  send: async (_task, _part, nonce, beforeSend) => { beforeSend(); return nonce; } };

function seed(store: ScheduleStore, state: TaskRun["state"], id = "task"): TaskRun {
  store.save({ ...task, id });
  const { run } = store.claim(id, now, limits.minimumMs)!;
  run.state = state;
  if (["ready", "sending", "delivery_failed"].includes(state)) run.parts = [{ content: "Saved output" }];
  store.saveRun(run);
  return run;
}

for (const phase of ["running", "ready", "partial", "sending"]) test(`SIGKILL during ${phase} recovers persisted work without duplicating acknowledged messages`, { timeout: 20_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-crash-"));
  const file = path.join(dir, "schedules.sqlite");
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { ScheduleStore } from './src/scheduling/store.ts';
    import { Scheduler } from './src/scheduling/engine.ts';
    import { createAccessPolicy } from './src/common/accessPolicy.ts';
    const [file, phase] = process.argv.slice(1);
    const checkpoint = () => { process.stdout.write('checkpoint\\n'); return new Promise(() => {}); };
    let authorizations = 0;
    const store = new ScheduleStore(file);
    const scheduler = new Scheduler(store, createAccessPolicy({DISCORD_ADMIN_USERS: '100'}), {
      authorize: async () => {
        authorizations++;
        if ((phase === 'ready' && authorizations === 2) || (phase === 'partial' && authorizations === 3)) await checkpoint();
      },
      generate: async () => {
        if (phase === 'running') await checkpoint();
        return [{content: 'First'}, {content: 'Second'}];
      },
      send: async (_task, _part, _nonce, beforeSend) => {
        beforeSend();
        if (phase === 'sending') await checkpoint();
        return 'already-sent';
      },
    }, ${JSON.stringify(limits)}, () => ${now});
    scheduler.start();
    store.save(${JSON.stringify(task)});
    scheduler.tick();
  `, file, phase], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  worker.stderr.on("data", chunk => { errors += chunk; });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    worker.stdout.on("data", chunk => { output += chunk; if (output.includes("checkpoint\n")) resolve(); });
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`Worker exited (${code}): ${errors}`)));
  });
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;

  const store = new ScheduleStore(file);
  const interrupted = store.runs(task.id)[0];
  assert.equal(interrupted.state, phase === "partial" ? "ready" : phase);
  let generations = 0;
  const sends: string[] = [];
  const scheduler = new Scheduler(store, access, { ...adapter,
    generate: async () => { generations++; return [{ content: "Recovered" }]; },
    send: async (_task, part, nonce, beforeSend) => { beforeSend(); sends.push(part.content); return nonce; },
  }, limits, () => now + 60_001);
  scheduler.start();
  try {
    await scheduler.idle();
    assert.equal(store.get(task.id)?.enabled, true);
    assert.equal(store.runs(task.id).length, 1);
    assert.equal(store.getRun(interrupted.id)?.state, phase === "sending" ? "uncertain" : "succeeded");
    assert.equal(generations, phase === "running" ? 1 : 0);
    assert.deepEqual(sends, phase === "sending" ? [] : phase === "running" ? ["Recovered"] : phase === "partial" ? ["Second"] : ["First", "Second"]);
    if (phase === "partial") assert.deepEqual(store.getRun(interrupted.id)?.messageIds, ["already-sent", `${interrupted.id}:1`]);
    if (phase === "sending") {
      await assert.rejects(scheduler.retryDelivery(admin, task.id, interrupted.id), /Uncertain sends/);
      await scheduler.runNow(admin, task.id);
      await scheduler.idle();
      assert.deepEqual(sends, ["Recovered"]);
    }
  } finally { await scheduler.stop(); }
});

test("a replacement scheduler waits for the lease, then recovers automatically and fences the old worker", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-lease-"));
  const file = path.join(dir, "schedules.sqlite");
  const first = new ScheduleStore(file);
  first.acquire(now);
  const run = seed(first, "running");
  const second = new ScheduleStore(file);
  let time = now + 1;
  const scheduler = new Scheduler(second, access, adapter, limits, () => time);
  t.after(async () => { await scheduler.stop(); first.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.doesNotThrow(() => scheduler.start());
  assert.throws(() => scheduler.assertAvailable(), /waiting.*automatically/);
  scheduler.tick();
  assert.equal(second.getRun(run.id)?.state, "running");
  time = now + 60_000;
  scheduler.tick();
  await scheduler.idle();
  assert.doesNotThrow(() => scheduler.assertAvailable());
  assert.equal(second.getRun(run.id)?.state, "succeeded");
  assert.throws(() => first.assertLease(time), /lease lost/);
});

test("stopping while waiting for a lease preserves the owner's lock and unfinished run", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-wait-stop-"));
  const file = path.join(dir, "schedules.sqlite");
  const owner = new ScheduleStore(file);
  owner.acquire(now);
  const run = seed(owner, "running");
  const waiting = new Scheduler(new ScheduleStore(file), access, adapter, limits, () => now + 1);
  t.after(async () => { await waiting.stop(); owner.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  waiting.start();
  await waiting.stop();
  assert.doesNotThrow(() => owner.assertLease(now + 1));
  assert.equal(owner.getRun(run.id)?.state, "running");
});

test("a stale provider cannot deliver or overwrite the replacement worker's recovered result", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-stale-worker-"));
  const file = path.join(dir, "schedules.sqlite");
  let time = now;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let staleSends = 0;
  const first = new Scheduler(new ScheduleStore(file), access, { ...adapter,
    generate: async () => { await gate; return [{ content: "Stale output" }]; },
    send: async () => { staleSends++; return "unexpected"; },
  }, limits, () => time);
  const second = new Scheduler(new ScheduleStore(file), access, adapter, limits, () => time);
  t.after(async () => { release(); await first.stop(); await second.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  first.start();
  first.store.save(task);
  const id = await first.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  time += 60_000;
  second.start();
  await second.idle();
  const recovered = second.store.getRun(id);
  assert.equal(recovered?.state, "succeeded");
  release();
  await first.idle();
  assert.equal(staleSends, 0);
  assert.deepEqual(second.store.getRun(id), recovered);
});

test("recovered generation and saved deliveries wait for worker capacity without overlapping", async () => {
  const store = new ScheduleStore(":memory:");
  store.acquire(now);
  const runs = [seed(store, "running", "one"), seed(store, "running", "two"), seed(store, "ready", "three")];
  // Advance beyond the seed lease while retaining this in-memory database.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let generated = 0;
  const scheduler = new Scheduler(store, access, { ...adapter, generate: async () => {
    generated++; await gate; return [{ content: "Recovered" }];
  } }, { ...limits, concurrency: 1 }, () => now + 60_000);
  scheduler.start();
  try {
    await new Promise(resolve => setImmediate(resolve));
    scheduler.tick();
    assert.equal(generated, 1);
    assert.equal(store.getRun(runs[1].id)?.state, "queued");
    assert.equal(store.getRun(runs[2].id)?.state, "ready");
    release();
    await scheduler.idle();
    scheduler.tick();
    await scheduler.idle();
    scheduler.tick();
    await scheduler.idle();
    assert.equal(generated, 2);
    for (const run of runs) assert.equal(store.getRun(run.id)?.state, "succeeded");
  } finally { release(); await scheduler.stop(); }
});

for (const change of ["paused", "edited", "expired", "future", "revoked"]) test(`recovery suppresses output when the schedule is ${change}`, async () => {
  const store = new ScheduleStore(":memory:");
  store.acquire(now);
  const run = seed(store, "ready");
  const current = store.get(task.id)!;
  if (change === "paused") store.pause(task.id, "Paused by a user.");
  if (change === "edited") store.save({ ...current, revision: 2 });
  if (change === "expired") store.save({ ...current, endAt: now + 30_000 });
  if (change === "future") store.save({ ...current, startAt: now + 120_000 });
  let sends = 0;
  const scheduler = new Scheduler(store, access, { ...adapter,
    authorize: async () => { if (change === "revoked") throw new ScheduleAccessError("Access revoked"); },
    send: async () => { sends++; return "unexpected"; },
  }, limits, () => now + 60_000);
  scheduler.start();
  try {
    await scheduler.idle();
    assert.equal(sends, 0);
    assert.equal(store.getRun(run.id)?.state, "cancelled");
    assert.equal(store.get(task.id)?.enabled, change === "edited" || change === "future");
  } finally { await scheduler.stop(); }
});

test("editing a queued recovery never posts stale output or pauses the edited schedule", async () => {
  const store = new ScheduleStore(":memory:");
  store.acquire(now);
  seed(store, "running", "one");
  const run = seed(store, "ready", "two");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const scheduler = new Scheduler(store, access, { ...adapter,
    generate: async () => { await gate; return [{ content: "First" }]; },
    send: async (_task, part) => { sent.push(part.content); return "message"; },
  }, { ...limits, concurrency: 1 }, () => now + 60_000);
  scheduler.start();
  try {
    await scheduler.edit(admin, "two", { content: "Changed" });
    release(); await scheduler.idle();
    scheduler.tick(); await scheduler.idle();
    assert.deepEqual(sent, ["First"]);
    assert.equal(store.getRun(run.id)?.state, "cancelled");
    assert.equal(store.get("two")?.enabled, true);
  } finally { release(); await scheduler.stop(); }
});

test("restart retry limits count generation attempts, not time spent queued, and keep the recurrence enabled", () => {
  const store = new ScheduleStore(":memory:");
  try {
    store.acquire(now);
    const run = seed(store, "running");
    for (let attempt = 1; attempt <= 4; attempt++) {
      store.recover(now + attempt);
      const recovered = store.getRun(run.id)!;
      assert.equal(recovered.recoveryAttempts, attempt);
      assert.equal(recovered.state, attempt <= 3 ? "queued" : "failed");
      assert.equal(store.get(task.id)?.enabled, true);
      store.recover(now + attempt);
      assert.equal(store.getRun(run.id)?.recoveryAttempts, attempt);
      if (attempt <= 3) store.saveRun({ ...recovered, state: "running" });
    }
    assert.equal(store.busy(task.id), false);
  } finally { store.close(); }
});

const legacyPause = "Interrupted by restart. Inspect before resuming; execution or delivery may have occurred.";
for (const outcome of ["generation", "sending", "edited", "paused", "expired"]) test(`upgrade repairs only untouched restart pauses: ${outcome}`, async () => {
  const store = new ScheduleStore(":memory:");
  store.acquire(now);
  const run = seed(store, "uncertain");
  store.saveRun({ ...run, error: legacyPause, parts: outcome === "sending" ? [{ content: "Possibly sent" }] : [] });
  store.pause(task.id, legacyPause);
  if (outcome === "edited") store.save({ ...store.get(task.id)!, revision: 3 });
  if (outcome === "paused") store.pause(task.id, "Paused by a user.");
  if (outcome === "expired") store.save({ ...store.get(task.id)!, endAt: now + 30_000 });
  const scheduler = new Scheduler(store, access, adapter, limits, () => now + 60_000);
  scheduler.start();
  try {
    await scheduler.idle();
    assert.equal(store.get(task.id)?.enabled, outcome === "generation" || outcome === "sending");
    assert.equal(store.getRun(run.id)?.state, outcome === "generation" ? "succeeded" : "uncertain");
    if (outcome === "generation") assert.equal(store.getRun(run.id)?.taskRevision, store.get(task.id)?.revision);
  } finally { await scheduler.stop(); }
});

test("upgrade recovers old saved-output failures but does not retry rejected Discord sends", async () => {
  const store = new ScheduleStore(":memory:");
  store.acquire(now);
  const saved = seed(store, "delivery_failed", "saved");
  const rejected = seed(store, "delivery_failed", "rejected");
  store.saveRun({ ...saved, error: "Output was saved before restart. Retry delivery if it is still wanted." });
  const scheduler = new Scheduler(store, access, adapter, limits, () => now + 60_000);
  scheduler.start();
  try {
    await scheduler.idle();
    assert.equal(store.getRun(saved.id)?.state, "succeeded");
    assert.equal(store.getRun(rejected.id)?.state, "delivery_failed");
  } finally { await scheduler.stop(); }
});

test("manual runs explain how to resume a user-paused schedule", async () => {
  const store = new ScheduleStore(":memory:");
  const scheduler = new Scheduler(store, access, adapter, limits, () => now);
  scheduler.start();
  try {
    store.save(task);
    scheduler.pause(admin, task.id);
    await assert.rejects(scheduler.runNow(admin, task.id), /Use \/schedule resume id:task/);
  } finally { await scheduler.stop(); }
});
