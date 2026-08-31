import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { Collection, Client, Message } from "discord.js";
import {
  HourlyReplyConfig,
  HourlyReplyScheduler,
  HourlyReplyStore,
  MessageHistoryChannel,
  fetchMessagesWithinWindow,
  hourlyReplyConfig,
  selectHourlyReplyMessages,
} from "../src/hourlyReplyScheduler.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface FakeMessage {
  id: string;
  createdTimestamp: number;
  author: { id: string; bot: boolean };
  reply: (content: string) => Promise<void>;
}

function asMessage(message: FakeMessage): Message {
  return message as unknown as Message;
}

function makeMessage(
  id: string,
  createdTimestamp: number,
  authorId: string,
  replies: string[],
  bot = false,
): Message {
  return asMessage({
    id,
    createdTimestamp,
    author: { id: authorId, bot },
    reply: async (content) => {
      replies.push(content);
    },
  });
}

function makePage(messages: Message[]): Collection<string, Message> {
  return new Collection(messages.map((message) => [message.id, message] as const));
}

test("hourly reply configuration is disabled until both IDs are set", () => {
  assert.equal(hourlyReplyConfig({}), undefined);

  const config = hourlyReplyConfig({
    DISCORD_HOURLY_REPLY_CHANNEL_ID: "channel-1",
    DISCORD_HOURLY_REPLY_AUTHOR_ID: "author-1",
    DISCORD_HOURLY_REPLY_INTERVAL_MS: "60000",
    DISCORD_HOURLY_REPLY_TEXT: "Proto on my team",
    DISCORD_HOURLY_REPLY_STATE_FILE: "/tmp/hourly-replies.json",
  });

  assert.deepEqual(config, {
    channelId: "channel-1",
    authorId: "author-1",
    intervalMs: 60000,
    replyText: "Proto on my team",
    stateFilePath: "/tmp/hourly-replies.json",
  });
});

test("message history pagination returns only messages in the requested window", async () => {
  const now = 10_000;
  const since = 5_000;
  const replies: string[] = [];
  const inWindow = makeMessage("in-window", 7_000, "author", replies);
  const newest = makeMessage("newest", 9_000, "other", replies);
  const old = makeMessage("old", 4_000, "author", replies);
  const firstPageMessages = [newest, inWindow, ...Array.from({ length: 98 }, (_, index) =>
    makeMessage(`filler-${index}`, 6_000 - index, "other", replies)
  )];
  const pages = [makePage(firstPageMessages), makePage([old])];
  const options: Array<{ limit: number; before?: string }> = [];
  const channel: MessageHistoryChannel = {
    messages: {
      fetch: async (request) => {
        options.push(request);
        return pages.shift() ?? new Collection<string, Message>();
      },
    },
  };

  const result = await fetchMessagesWithinWindow(channel, since, now);

  assert.equal(result.length, 100);
  assert.equal(result[0].id, "filler-97");
  assert.equal(result.at(-1)?.id, "newest");
  assert.equal(result.some((message) => message.id === "old"), false);
  assert.equal(options.length, 2);
  assert.equal(options[0].limit, 100);
  assert.equal(options[1].before, "filler-97");
});

test("candidate selection excludes other authors, bots, and replied messages", () => {
  const replies: string[] = [];
  const target = makeMessage("target", 1, "target-author", replies);
  const other = makeMessage("other", 2, "other-author", replies);
  const bot = makeMessage("bot", 3, "target-author", replies, true);

  assert.deepEqual(
    selectHourlyReplyMessages(
      [target, other, bot],
      "target-author",
      (messageId) => messageId === "target",
    ),
    [],
  );
  assert.deepEqual(
    selectHourlyReplyMessages(
      [target, other, bot],
      "target-author",
      () => false,
    ),
    [target],
  );
});

test("reply state persists and can be pruned", () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-hourly-replies-"));
  const filePath = join(directory, "state.json");
  try {
    const first = new HourlyReplyStore(filePath);
    first.markReplied("message-1", 100);

    const second = new HourlyReplyStore(filePath);
    assert.equal(second.has("message-1"), true);
    second.prune(101);

    const third = new HourlyReplyStore(filePath);
    assert.equal(third.has("message-1"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduler replies once to matching messages in the last interval", async () => {
  const replies: string[] = [];
  const target = makeMessage("target", 9_000, "target-author", replies);
  const other = makeMessage("other", 9_500, "other-author", replies);
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async () => makePage([target, other]),
    },
  };
  const client = {
    channels: { fetch: async () => channel },
  } as unknown as Client;
  const stateDirectory = mkdtempSync(join(tmpdir(), "ai-hourly-scheduler-"));
  const config: HourlyReplyConfig = {
    channelId: "channel-1",
    authorId: "target-author",
    replyText: "Proto on my team",
    intervalMs: 1_000,
    stateFilePath: join(stateDirectory, "state.json"),
  };
  const store = new HourlyReplyStore(config.stateFilePath);
  const scheduler = new HourlyReplyScheduler(client, config, store, () => 10_000);

  try {
    assert.equal(await scheduler.run(), 1);
    assert.equal(await scheduler.run(), 0);
    assert.deepEqual(replies, ["Proto on my team"]);
  } finally {
    scheduler.stop();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
