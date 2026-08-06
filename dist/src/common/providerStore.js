import fs from "fs";
import os from "os";
import path from "path";
/**
 * Persists the active provider choice per Discord session key (user ID or
 * thread ID), so a user's chosen provider survives a bot restart. Keys without
 * an override fall back to the default provider from the PROVIDER env var.
 *
 * This is separate from SessionStore, which maps a Discord key to a single
 * provider's session ID.
 */
export class ProviderStore {
    filePath;
    data = {};
    constructor(filePath) {
        this.filePath =
            filePath ?? path.join(os.homedir(), ".config", "ai-assistant", "providers.json");
        this.load();
    }
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, "utf8");
            this.data = JSON.parse(raw);
        }
        catch {
            this.data = {};
        }
    }
    get(key) {
        return this.data[key];
    }
    /** All persisted (key → provider) overrides. */
    all() {
        return { ...this.data };
    }
    set(key, provider) {
        if (this.data[key] === provider)
            return;
        this.data[key] = provider;
        this.persist();
    }
    delete(key) {
        delete this.data[key];
        this.persist();
    }
    persist() {
        try {
            const dir = path.dirname(this.filePath);
            fs.mkdirSync(dir, { recursive: true });
            const tmp = this.filePath + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            fs.renameSync(tmp, this.filePath);
        }
        catch (err) {
            console.error("[ProviderStore] Failed to persist providers:", err);
        }
    }
}
