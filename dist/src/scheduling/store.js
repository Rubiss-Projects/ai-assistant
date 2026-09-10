import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nextOccurrences } from "./cron.js";
/** One active scheduler per database. A lease fences stale workers before external delivery. */
export class ScheduleStore {
    db;
    owner = randomUUID();
    constructor(file) {
        if (file !== ":memory:")
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new Database(file);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.db.pragma("busy_timeout = 5000");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL, next_run INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(enabled, next_run);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, occurrence TEXT NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id, occurrence));
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, started);
    `);
    }
    acquire(now) {
        const result = this.db.prepare(`INSERT INTO scheduler_lock VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE scheduler_lock.expires <= ?`).run(this.owner, now + 60_000, now);
        if (!result.changes)
            throw new Error("Another scheduler owns this database. Wait for its 60-second lease to expire.");
    }
    renew(now) {
        const result = this.db.prepare("UPDATE scheduler_lock SET expires=? WHERE owner=? AND expires>?").run(now + 60_000, this.owner, now);
        if (!result.changes)
            throw new Error("Scheduler lease lost; restart required.");
    }
    assertLease(now = Date.now()) {
        if (!this.db.prepare("SELECT 1 FROM scheduler_lock WHERE owner=? AND expires>?").get(this.owner, now))
            throw new Error("Scheduler lease lost; restart required.");
    }
    close() {
        if (!this.db.open)
            return;
        this.db.prepare("DELETE FROM scheduler_lock WHERE owner=?").run(this.owner);
        this.db.close();
    }
    get(id) {
        const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
        return row ? JSON.parse(row.data) : undefined;
    }
    list(guildId) {
        const rows = (guildId ? this.db.prepare("SELECT data FROM tasks WHERE guild_id=? ORDER BY next_run").all(guildId)
            : this.db.prepare("SELECT data FROM tasks ORDER BY next_run").all());
        return rows.map(row => JSON.parse(row.data));
    }
    save(task) {
        this.db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, next_run=excluded.next_run, data=excluded.data`).run(task.id, task.guildId, task.ownerId, Number(task.enabled), task.nextRunAt, JSON.stringify(task));
    }
    create(task, maxOwner, maxGuild) {
        this.db.transaction(() => {
            const owner = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE owner_id=?").get(task.ownerId);
            const guild = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE guild_id=?").get(task.guildId);
            if (owner.n >= maxOwner || guild.n >= maxGuild)
                throw new Error("Schedule limit reached. Delete an existing task first.");
            this.save(task);
        }).immediate();
    }
    delete(id) { this.db.prepare("DELETE FROM tasks WHERE id=?").run(id); }
    pause(id, reason) {
        const task = this.get(id);
        if (task)
            this.save({ ...task, enabled: false, revision: task.revision + 1, pauseReason: reason });
    }
    runs(taskId) {
        const rows = this.db.prepare("SELECT data FROM runs WHERE task_id=? ORDER BY started DESC LIMIT 20").all(taskId);
        return rows.map(row => JSON.parse(row.data));
    }
    getRun(id) {
        const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
        return row ? JSON.parse(row.data) : undefined;
    }
    saveRun(run) {
        this.db.prepare("UPDATE runs SET state=?, data=? WHERE id=?").run(run.state, JSON.stringify(run), run.id);
    }
    busy(taskId) {
        return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE task_id=? AND state IN ('running','ready','sending')").get(taskId));
    }
    claim(taskId, now, minimumMs, manual = false) {
        return this.db.transaction(() => {
            this.assertLease(now);
            const task = this.get(taskId);
            if (!task || !task.enabled || (!manual && task.nextRunAt > now))
                return;
            if (this.busy(taskId) || (task.lastStartedAt !== undefined && now - task.lastStartedAt < minimumMs)) {
                if (!manual) {
                    task.nextRunAt = nextOccurrences(task.cron, task.timezone, now, 1)[0];
                    this.save(task);
                }
                return;
            }
            const occurrence = manual ? `manual:${randomUUID()}` : String(task.nextRunAt);
            const run = { id: randomUUID(), taskId, channelId: task.channelId, taskRevision: task.revision, occurrence, startedAt: now, state: "running", parts: [], messageIds: [] };
            this.db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)").run(run.id, taskId, occurrence, run.state, now, JSON.stringify(run));
            task.nextRunAt = nextOccurrences(task.cron, task.timezone, now, 1)[0];
            task.lastStartedAt = now;
            this.save(task);
            // Keep bounded run history, retaining any run that still needs attention.
            this.db.prepare(`DELETE FROM runs WHERE task_id=? AND state IN ('succeeded','failed','cancelled') AND id NOT IN (SELECT id FROM runs WHERE task_id=? ORDER BY started DESC LIMIT 20)`).run(taskId, taskId);
            return { task, run };
        }).immediate();
    }
    recover(now) {
        this.db.transaction(() => {
            this.assertLease(now);
            const interrupted = this.db.prepare("SELECT data FROM runs WHERE state IN ('running','ready','sending')").all();
            for (const row of interrupted) {
                const run = JSON.parse(row.data);
                const unsent = run.state === "ready";
                run.state = unsent ? "delivery_failed" : "uncertain";
                run.error = unsent ? "Output was saved before restart. Retry delivery if it is still wanted."
                    : "Interrupted by restart. Inspect before resuming; execution or delivery may have occurred.";
                this.saveRun(run);
                if (!unsent)
                    this.pause(run.taskId, run.error);
            }
            for (const task of this.list()) {
                if (task.enabled && task.nextRunAt <= now) {
                    task.nextRunAt = nextOccurrences(task.cron, task.timezone, now, 1)[0];
                    this.save(task);
                }
            }
        }).immediate();
    }
}
