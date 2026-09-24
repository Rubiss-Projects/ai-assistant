import fs from "fs";
import os from "os";
import path from "path";
/**
 * Persists the mapping of Discord session keys (user ID or thread ID) to the
 * provider's session/thread ID so sessions can be resumed after a bot restart.
 *
 * Providers keep history on disk. We persist IDs and the context acknowledged by
 * each provider; old string-only records migrate lazily on the next successful run.
 *
 * The store is namespaced per provider so multiple providers can map the same
 * Discord key without colliding (file: sessions-<namespace>.json).
 */
export class SessionStore {
    filePath;
    data = {};
    constructor(namespace = "sessions", filePath) {
        const fileName = namespace === "sessions" ? "sessions.json" : `sessions-${namespace}.json`;
        this.filePath = filePath ?? path.join(os.homedir(), ".config", "ai-assistant", fileName);
        this.load();
    }
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("Invalid session store.");
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === "string")
                    this.data[key] = { sessionId: value };
                else if (value && typeof value === "object" && "sessionId" in value && typeof value.sessionId === "string") {
                    const context = "context" in value ? value.context : undefined;
                    this.data[key] = {
                        sessionId: value.sessionId,
                        ...(context && typeof context === "object" && "instructions" in context && typeof context.instructions === "string"
                            && "capabilities" in context && typeof context.capabilities === "string" ? { context: { instructions: context.instructions, capabilities: context.capabilities } } : {}),
                        ...("handoff" in value && typeof value.handoff === "string" ? { handoff: value.handoff } : {}),
                    };
                }
                else
                    throw new Error(`Invalid session record: ${key}`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    get(key) {
        return this.data[key]?.sessionId;
    }
    getState(key) {
        const value = this.data[key];
        return value ? structuredClone(value) : undefined;
    }
    set(key, sessionId, context, handoff) {
        const previous = this.data[key];
        const state = context ? { sessionId, context, ...(handoff ? { handoff } : {}) }
            : previous?.sessionId === sessionId ? previous : { sessionId };
        if (JSON.stringify(previous) === JSON.stringify(state))
            return;
        this.persist({ ...this.data, [key]: state });
    }
    delete(key) {
        if (!(key in this.data))
            return;
        const next = { ...this.data };
        delete next[key];
        this.persist(next);
    }
    persist(next) {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = this.filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.filePath); // atomic replace — no partial-write corruption
        this.data = next;
    }
}
