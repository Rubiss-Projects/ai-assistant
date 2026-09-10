import { randomUUID } from "node:crypto";
import { RunTimeoutError } from "../providers/types.js";
import { validateSchedule, nextOccurrences } from "./cron.js";
export function scheduleLimits(env = process.env) {
    const number = (key, fallback, min, max) => {
        const value = env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
        if (!Number.isSafeInteger(value) || value < min || value > max)
            throw new Error(`Invalid ${key}: expected ${min}–${max}.`);
        return value;
    };
    return {
        minimumMs: number("SCHEDULE_MIN_INTERVAL_MINUTES", 15, 1, 1440) * 60_000,
        maxOwner: number("SCHEDULE_MAX_PER_USER", 10, 1, 1000), maxGuild: number("SCHEDULE_MAX_PER_GUILD", 50, 1, 10000),
        concurrency: number("SCHEDULE_CONCURRENCY", 2, 1, 10), timeoutMs: number("SCHEDULE_AI_TIMEOUT_MS", 600_000, 1000, 3_600_000),
    };
}
export class ScheduleAccessError extends Error {
}
export class DeliveryRejectedError extends Error {
}
export class Scheduler {
    store;
    access;
    adapter;
    limits;
    now;
    active = new Set();
    timer;
    stopped = true;
    constructor(store, access, adapter, limits = scheduleLimits(), now = Date.now) {
        this.store = store;
        this.access = access;
        this.adapter = adapter;
        this.limits = limits;
        this.now = now;
    }
    start() {
        this.store.acquire(this.now());
        this.store.recover(this.now());
        this.stopped = false;
        this.timer = setInterval(() => {
            try {
                this.store.renew(this.now());
                this.tick();
            }
            catch (error) {
                this.stopped = true;
                clearInterval(this.timer);
                console.error("[scheduler] Stopped:", error);
            }
        }, 5000);
    }
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        // Keep the lease alive while already-running providers drain.
        const heartbeat = setInterval(() => { try {
            this.store.renew(this.now());
        }
        catch { /* Delivery checks still fence this worker. */ } }, 5000);
        try {
            await Promise.allSettled(this.active);
        }
        finally {
            clearInterval(heartbeat);
            this.store.close();
        }
    }
    assertAvailable() {
        if (this.stopped)
            throw new Error("Scheduler is not running.");
        this.store.assertLease(this.now());
    }
    canManage(subject, task) {
        return this.access.can(subject, "schedule.manage.guild", task) || this.access.can(subject, "schedule.manage.own", task);
    }
    requireManage(subject, task) {
        if (!this.canManage(subject, task))
            throw new ScheduleAccessError("You cannot manage this schedule.");
    }
    requireCreate(subject, task) {
        if (!this.access.can(subject, task.kind === "ai" ? "schedule.ai.create" : "schedule.message.create", task)) {
            throw new ScheduleAccessError(task.kind === "ai" ? "AI schedules require an explicit bot administrator." : "You do not have permission to create message schedules.");
        }
    }
    async create(subject, input) {
        this.assertAvailable();
        this.requireCreate(subject, input);
        const task = { ...input, id: randomUUID(), ownerId: subject.userId, createdAt: this.now(), revision: 1, enabled: true, nextRunAt: 0 };
        this.validate(task);
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        this.store.create(task, this.limits.maxOwner, this.limits.maxGuild);
        return task;
    }
    validate(task) {
        if (!["message", "ai"].includes(task.kind) || !task.content.trim() || task.content.length > 6000)
            throw new Error("Provide message text or a prompt of 1–6000 characters.");
        if (!Number.isInteger(task.contextMessages) || task.contextMessages < 0 || task.contextMessages > 100)
            throw new Error("Context messages must be between 0 and 100.");
        if (task.kind === "message" && task.contextMessages !== 0)
            throw new Error("Fixed messages cannot use AI context.");
        if (task.kind === "ai" && (!task.provider || !task.model))
            throw new Error("AI schedules require a saved provider and model.");
        task.nextRunAt = validateSchedule(task.cron, task.timezone, this.limits.minimumMs, this.now());
    }
    async edit(subject, id, patch) {
        this.assertAvailable();
        const before = this.requireTask(subject, id);
        this.requireCreate(subject, before);
        const task = { ...before, ...patch, revision: before.revision + 1 };
        this.validate(task);
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        const latest = this.store.get(id);
        if (latest?.revision !== before.revision)
            throw new Error("Schedule changed; try again.");
        task.lastStartedAt = latest.lastStartedAt;
        this.store.save(task);
        return task;
    }
    requireTask(subject, id) {
        const task = this.store.get(id);
        if (!task || !this.canManage(subject, task))
            throw new ScheduleAccessError("Schedule not found or unavailable to you.");
        return task;
    }
    pause(subject, id) { this.assertAvailable(); this.requireTask(subject, id); this.store.pause(id, "Paused by a user."); }
    delete(subject, id) { this.assertAvailable(); this.requireTask(subject, id); this.store.delete(id); }
    async resume(subject, id) {
        this.assertAvailable();
        const task = this.requireTask(subject, id);
        this.requireCreate(subject, task);
        if (this.store.busy(id))
            throw new Error("Wait for the active run to finish before resuming.");
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        if (this.store.get(id)?.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        this.store.save({ ...task, enabled: true, pauseReason: undefined, revision: task.revision + 1,
            nextRunAt: validateSchedule(task.cron, task.timezone, this.limits.minimumMs, this.now()) });
    }
    async authorizeManual(subject, id) {
        this.assertAvailable();
        const task = this.requireTask(subject, id);
        this.requireCreate(subject, task);
        // Reject the requester before claiming work or modifying a saved delivery.
        // Requester-only failures must not change the owner's recurring schedule.
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        const latest = this.requireTask(subject, id);
        if (latest.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        return latest;
    }
    async runNow(subject, id) {
        const task = await this.authorizeManual(subject, id);
        this.assertAvailable();
        if (this.store.get(id)?.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        if (this.active.size >= this.limits.concurrency)
            throw new Error("Scheduler is busy; try again later.");
        const claimed = this.store.claim(id, this.now(), this.limits.minimumMs, true);
        if (!claimed)
            throw new Error("Task is paused, already running, or within its minimum run interval.");
        this.launch(claimed.task, claimed.run);
        return claimed.run.id;
    }
    async retryDelivery(subject, id, runId) {
        const task = await this.authorizeManual(subject, id);
        this.assertAvailable();
        if (this.store.get(id)?.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        const run = this.store.getRun(runId);
        if (!run || run.taskId !== id || run.state !== "delivery_failed" || run.taskRevision !== task.revision) {
            throw new Error("Only a definitely rejected delivery from the current task revision can be retried. Uncertain sends need manual inspection.");
        }
        if (!task.enabled || this.store.busy(id) || this.active.size >= this.limits.concurrency)
            throw new Error("Task is paused or scheduler is busy.");
        run.state = "ready";
        run.error = undefined;
        this.store.saveRun(run);
        this.launch(task, run);
    }
    tick() {
        if (this.stopped)
            return;
        this.store.assertLease(this.now());
        for (const task of this.store.list()) {
            if (!task.enabled || task.nextRunAt > this.now())
                continue;
            // Do not accumulate a backlog while all worker slots are occupied.
            if (this.active.size >= this.limits.concurrency) {
                this.store.save({ ...task, nextRunAt: nextOccurrences(task.cron, task.timezone, this.now(), 1)[0] });
                continue;
            }
            const claimed = this.store.claim(task.id, this.now(), this.limits.minimumMs);
            if (claimed)
                this.launch(claimed.task, claimed.run);
        }
    }
    launch(task, run) {
        const pending = this.execute(task, run).catch(error => console.error("[scheduler] Run persistence failed:", error));
        this.active.add(pending);
        void pending.finally(() => this.active.delete(pending));
    }
    async idle() { await Promise.all(this.active); }
    current(task) {
        this.store.assertLease(this.now());
        const latest = this.store.get(task.id);
        // stop() rejects new work but drains claimed runs while retaining the lease.
        if (!latest?.enabled || latest.revision !== task.revision)
            throw new ScheduleAccessError("Task was paused, edited, or deleted.");
    }
    async execute(task, run) {
        try {
            this.current(task);
            await this.adapter.authorize(task);
            this.current(task);
            if (run.state === "running") {
                run.parts = await this.adapter.generate(task, run, this.limits.timeoutMs);
                this.current(task);
                if (!run.parts.length || JSON.stringify(run.parts).length > 20_000_000)
                    throw new Error("Scheduled output is empty or exceeds the 20 MB run limit.");
                run.state = "ready";
                this.store.saveRun(run);
            }
            for (const part of run.parts.slice(run.messageIds.length)) {
                await this.adapter.authorize(task);
                this.current(task);
                run.state = "sending";
                this.store.saveRun(run);
                const messageId = await this.adapter.send(task, part, `${run.id}:${run.messageIds.length}`, () => this.current(task));
                this.store.assertLease(this.now());
                run.messageIds.push(messageId);
                run.state = "ready";
                this.store.saveRun(run);
            }
            run.state = "succeeded";
            // IDs are enough for successful history; avoid retaining large attachment payloads.
            run.parts = [];
            this.store.saveRun(run);
        }
        catch (error) {
            // If another worker recovered this run, never overwrite its recovery decision.
            this.store.assertLease(this.now());
            run.error = error instanceof ScheduleAccessError ? error.message : "Run failed; see bot logs for details.";
            console.error(`[scheduler] Run ${run.id}:`, error);
            if (error instanceof ScheduleAccessError)
                run.state = "cancelled";
            else if (error instanceof DeliveryRejectedError)
                run.state = "delivery_failed";
            else if (run.state === "sending" || (error instanceof RunTimeoutError && !error.cancellationConfirmed))
                run.state = "uncertain";
            else
                run.state = "failed";
            this.store.saveRun(run);
            const latest = this.store.get(task.id);
            if (latest?.revision === task.revision && (error instanceof ScheduleAccessError || run.state === "uncertain"
                || this.store.runs(task.id).slice(0, 3).filter(previous => previous.state === "failed").length === 3)) {
                this.store.pause(task.id, run.error);
            }
        }
    }
}
