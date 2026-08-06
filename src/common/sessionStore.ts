import fs from "fs";
import os from "os";
import path from "path";

/**
 * Persists the mapping of Discord session keys (user ID or thread ID) to the
 * provider's session/thread ID so sessions can be resumed after a bot restart.
 *
 * Each provider already keeps session data on disk; we only need to store the
 * ID lookup. Uses synchronous I/O since the file is tiny (<1 KB).
 *
 * The store is namespaced per provider so multiple providers can map the same
 * Discord key without colliding (file: sessions-<namespace>.json).
 */
export class SessionStore {
  private readonly filePath: string;
  private data: Record<string, string> = {};

  constructor(namespace = "sessions") {
    const fileName = namespace === "sessions" ? "sessions.json" : `sessions-${namespace}.json`;
    this.filePath = path.join(os.homedir(), ".config", "ai-assistant", fileName);
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.data = JSON.parse(raw);
    } catch {
      // File missing or malformed — start fresh
      this.data = {};
    }
  }

  get(key: string): string | undefined {
    return this.data[key];
  }

  set(key: string, sessionId: string): void {
    if (this.data[key] === sessionId) return; // skip disk write if unchanged
    this.data[key] = sessionId;
    this.persist();
  }

  delete(key: string): void {
    delete this.data[key];
    this.persist();
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath); // atomic replace — no partial-write corruption
    } catch (err) {
      console.error("[SessionStore] Failed to persist sessions:", err);
    }
  }
}
