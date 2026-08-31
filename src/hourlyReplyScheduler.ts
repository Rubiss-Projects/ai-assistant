import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, Collection, Events, Message } from "discord.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REPLY_TEXT = "Proto on my team";
const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  ".config",
  "ai-assistant",
  "hourly-replies.json",
);
const MESSAGE_PAGE_SIZE = 100;

export interface HourlyReplyConfig {
  channelId: string;
  authorId: string;
  replyText: string;
  intervalMs: number;
  stateFilePath: string;
}

interface HourlyReplyRecord {
  messageId: string;
  repliedAt: number;
}

export interface MessageHistoryChannel {
  messages: {
    fetch(options: { limit: number; before?: string }): Promise<Collection<string, Message>>;
  };
}

function parseInterval(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 10 ? parsed : DEFAULT_INTERVAL_MS;
}

export function hourlyReplyConfig(env: NodeJS.ProcessEnv = process.env): HourlyReplyConfig | undefined {
  const channelId = env.DISCORD_HOURLY_REPLY_CHANNEL_ID?.trim();
  const authorId = env.DISCORD_HOURLY_REPLY_AUTHOR_ID?.trim();
  if (!channelId || !authorId) return undefined;

  return {
    channelId,
    authorId,
    replyText: env.DISCORD_HOURLY_REPLY_TEXT?.trim() || DEFAULT_REPLY_TEXT,
    intervalMs: parseInterval(env.DISCORD_HOURLY_REPLY_INTERVAL_MS),
    stateFilePath: env.DISCORD_HOURLY_REPLY_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
  };
}

export class HourlyReplyStore {
  private records = new Map<string, HourlyReplyRecord>();

  constructor(private readonly filePath: string = DEFAULT_STATE_FILE) {
    this.load();
  }

  has(messageId: string): boolean {
    return this.records.has(messageId);
  }

  markReplied(messageId: string, repliedAt = Date.now()): void {
    if (this.records.has(messageId)) return;
    this.records.set(messageId, { messageId, repliedAt });
    this.persist();
  }

  prune(repliedBefore: number): void {
    let changed = false;
    for (const [messageId, record] of this.records) {
      if (record.repliedAt < repliedBefore) {
        this.records.delete(messageId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;

      for (const value of parsed) {
        if (!value || typeof value !== "object") continue;
        const record = value as Partial<HourlyReplyRecord>;
        if (typeof record.messageId !== "string" || typeof record.repliedAt !== "number") continue;
        this.records.set(record.messageId, {
          messageId: record.messageId,
          repliedAt: record.repliedAt,
        });
      }
    } catch {
      // Missing or malformed state is safe to treat as empty.
    }
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.records.values()], null, 2));
    fs.renameSync(temporary, this.filePath);
  }
}

export async function fetchMessagesWithinWindow(
  channel: MessageHistoryChannel,
  since: number,
  until: number,
): Promise<Message[]> {
  const messages = new Map<string, Message>();
  let before: string | undefined;

  while (true) {
    const page = await channel.messages.fetch({
      limit: MESSAGE_PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    if (page.size === 0) break;

    for (const message of page.values()) {
      if (message.createdTimestamp >= since && message.createdTimestamp <= until) {
        messages.set(message.id, message);
      }
    }

    const oldest = [...page.values()].reduce((current, message) =>
      message.createdTimestamp < current.createdTimestamp ? message : current
    );
    if (oldest.createdTimestamp < since || page.size < MESSAGE_PAGE_SIZE) break;
    before = oldest.id;
  }

  return [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export function selectHourlyReplyMessages(
  messages: readonly Message[],
  authorId: string,
  alreadyReplied: (messageId: string) => boolean,
): Message[] {
  return messages.filter((message) =>
    message.author.id === authorId &&
    !message.author.bot &&
    !alreadyReplied(message.id)
  );
}

export class HourlyReplyScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopped = false;
  private running = false;

  private readonly onReady = (): void => {
    if (this.stopped) return;
    void this.run();
    this.timer = setInterval(() => {
      void this.run();
    }, this.config.intervalMs);
  };

  constructor(
    private readonly client: Client,
    private readonly config: HourlyReplyConfig,
    private readonly store = new HourlyReplyStore(config.stateFilePath),
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.client.isReady()) this.onReady();
    else this.client.once(Events.ClientReady, this.onReady);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async run(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;

    const until = this.now();
    const since = until - this.config.intervalMs;
    try {
      const channel = await this.client.channels.fetch(this.config.channelId);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) {
        console.warn(`[hourly-replies] Channel ${this.config.channelId} is not message-readable.`);
        return 0;
      }

      const messages = await fetchMessagesWithinWindow(
        channel as unknown as MessageHistoryChannel,
        since,
        until,
      );
      const candidates = selectHourlyReplyMessages(
        messages,
        this.config.authorId,
        (messageId) => this.store.has(messageId),
      );

      let replied = 0;
      for (const message of candidates) {
        try {
          await message.reply(this.config.replyText);
          this.store.markReplied(message.id, until);
          replied += 1;
        } catch (error) {
          console.warn(`[hourly-replies] Could not reply to message ${message.id}:`, error);
        }
      }

      // Keep the state bounded while retaining enough history to survive a restart.
      this.store.prune(until - Math.max(this.config.intervalMs * 2, 24 * 60 * 60 * 1000));
      console.log(`[hourly-replies] Scanned ${messages.length} message(s); replied to ${replied}.`);
      return replied;
    } catch (error) {
      console.error("[hourly-replies] Scan failed:", error);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

export function createHourlyReplyScheduler(
  client: Client,
  env: NodeJS.ProcessEnv = process.env,
): HourlyReplyScheduler | undefined {
  const config = hourlyReplyConfig(env);
  if (!config) return undefined;

  console.log(
    `[hourly-replies] Enabled for channel ${config.channelId}, author ${config.authorId}, interval ${config.intervalMs}ms.`,
  );
  return new HourlyReplyScheduler(client, config);
}
