import fs from "fs";
import os from "os";
import path from "path";

export interface DiscordMemory {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  sourceUrl: string;
  createdAt: string;
}

export class DiscordMemoryStore {
  private readonly filePath: string;
  private memories: DiscordMemory[] = [];

  constructor(filePath = path.join(os.homedir(), ".config", "ai-assistant", "memories.json")) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.memories = Array.isArray(value) ? value : [];
    } catch {
      this.memories = [];
    }
  }

  all(guildId: string): DiscordMemory[] {
    return this.memories.filter((memory) => memory.guildId === guildId);
  }

  add(memory: DiscordMemory): void {
    this.memories.push(memory);
    this.persist();
  }

  delete(ids: ReadonlySet<string>): number {
    const before = this.memories.length;
    this.memories = this.memories.filter((memory) => !ids.has(memory.id));
    if (this.memories.length !== before) this.persist();
    return before - this.memories.length;
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.memories, null, 2));
    fs.renameSync(temporary, this.filePath);
  }
}
