import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Events } from "discord.js";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REPLY_TEXT = "Proto on my team";
const DEFAULT_STATE_FILE = path.join(os.homedir(), ".config", "ai-assistant", "hourly-replies.json");
const MESSAGE_PAGE_SIZE = 100;
function parseInterval(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 10 ? parsed : DEFAULT_INTERVAL_MS;
}
export function hourlyReplyConfig(env = process.env) {
    const channelId = env.DISCORD_HOURLY_REPLY_CHANNEL_ID?.trim();
    const authorId = env.DISCORD_HOURLY_REPLY_AUTHOR_ID?.trim();
    if (!channelId || !authorId)
        return undefined;
    return {
        channelId,
        authorId,
        replyText: env.DISCORD_HOURLY_REPLY_TEXT?.trim() || DEFAULT_REPLY_TEXT,
        intervalMs: parseInterval(env.DISCORD_HOURLY_REPLY_INTERVAL_MS),
        stateFilePath: env.DISCORD_HOURLY_REPLY_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
    };
}
export class HourlyReplyStore {
    filePath;
    records = new Map();
    constructor(filePath = DEFAULT_STATE_FILE) {
        this.filePath = filePath;
        this.load();
    }
    has(messageId) {
        return this.records.has(messageId);
    }
    markReplied(messageId, repliedAt = Date.now()) {
        if (this.records.has(messageId))
            return;
        this.records.set(messageId, { messageId, repliedAt });
        this.persist();
    }
    prune(repliedBefore) {
        let changed = false;
        for (const [messageId, record] of this.records) {
            if (record.repliedAt < repliedBefore) {
                this.records.delete(messageId);
                changed = true;
            }
        }
        if (changed)
            this.persist();
    }
    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (!Array.isArray(parsed))
                return;
            for (const value of parsed) {
                if (!value || typeof value !== "object")
                    continue;
                const record = value;
                if (typeof record.messageId !== "string" || typeof record.repliedAt !== "number")
                    continue;
                this.records.set(record.messageId, {
                    messageId: record.messageId,
                    repliedAt: record.repliedAt,
                });
            }
        }
        catch {
            // Missing or malformed state is safe to treat as empty.
        }
    }
    persist() {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify([...this.records.values()], null, 2));
        fs.renameSync(temporary, this.filePath);
    }
}
export async function fetchMessagesWithinWindow(channel, since, until) {
    const messages = new Map();
    let before;
    while (true) {
        const page = await channel.messages.fetch({
            limit: MESSAGE_PAGE_SIZE,
            ...(before ? { before } : {}),
        });
        if (page.size === 0)
            break;
        for (const message of page.values()) {
            if (message.createdTimestamp >= since && message.createdTimestamp <= until) {
                messages.set(message.id, message);
            }
        }
        const oldest = [...page.values()].reduce((current, message) => message.createdTimestamp < current.createdTimestamp ? message : current);
        if (oldest.createdTimestamp < since || page.size < MESSAGE_PAGE_SIZE)
            break;
        before = oldest.id;
    }
    return [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}
export function selectHourlyReplyMessages(messages, authorId, alreadyReplied) {
    return messages.filter((message) => message.author.id === authorId &&
        !message.author.bot &&
        !alreadyReplied(message.id));
}
export class HourlyReplyScheduler {
    client;
    config;
    store;
    now;
    timer;
    started = false;
    stopped = false;
    running = false;
    onReady = () => {
        if (this.stopped)
            return;
        void this.run();
        this.timer = setInterval(() => {
            void this.run();
        }, this.config.intervalMs);
    };
    constructor(client, config, store = new HourlyReplyStore(config.stateFilePath), now = Date.now) {
        this.client = client;
        this.config = config;
        this.store = store;
        this.now = now;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        if (this.client.isReady())
            this.onReady();
        else
            this.client.once(Events.ClientReady, this.onReady);
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    async run() {
        if (this.running || this.stopped)
            return 0;
        this.running = true;
        const until = this.now();
        const since = until - this.config.intervalMs;
        try {
            const channel = await this.client.channels.fetch(this.config.channelId);
            if (!channel || !channel.isTextBased() || !("messages" in channel)) {
                console.warn(`[hourly-replies] Channel ${this.config.channelId} is not message-readable.`);
                return 0;
            }
            const messages = await fetchMessagesWithinWindow(channel, since, until);
            const candidates = selectHourlyReplyMessages(messages, this.config.authorId, (messageId) => this.store.has(messageId));
            let replied = 0;
            for (const message of candidates) {
                try {
                    await message.reply(this.config.replyText);
                    this.store.markReplied(message.id, until);
                    replied += 1;
                }
                catch (error) {
                    console.warn(`[hourly-replies] Could not reply to message ${message.id}:`, error);
                }
            }
            // Keep the state bounded while retaining enough history to survive a restart.
            this.store.prune(until - Math.max(this.config.intervalMs * 2, 24 * 60 * 60 * 1000));
            console.log(`[hourly-replies] Scanned ${messages.length} message(s); replied to ${replied}.`);
            return replied;
        }
        catch (error) {
            console.error("[hourly-replies] Scan failed:", error);
            return 0;
        }
        finally {
            this.running = false;
        }
    }
}
export function createHourlyReplyScheduler(client, env = process.env) {
    const config = hourlyReplyConfig(env);
    if (!config)
        return undefined;
    console.log(`[hourly-replies] Enabled for channel ${config.channelId}, author ${config.authorId}, interval ${config.intervalMs}ms.`);
    return new HourlyReplyScheduler(client, config);
}
