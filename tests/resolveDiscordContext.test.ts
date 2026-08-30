import assert from "node:assert/strict";
import test from "node:test";
import { resolveDiscordContext } from "../src/utils/resolveDiscordContext.js";

function contextMessage(id: string, content: string, timestamp: number, username: string) {
  return {
    id,
    content,
    createdTimestamp: timestamp,
    createdAt: new Date(timestamp),
    author: { globalName: null, username },
    member: null,
    embeds: [],
    attachments: new Map(),
  };
}

test("reply context includes nearby messages in order and excludes the invocation", async () => {
  const before = contextMessage("before", "earlier context", 1, "alice");
  const target = contextMessage("target", "the message being discussed", 2, "bob");
  const after = contextMessage("after", "later context", 3, "carol");
  const invocation = contextMessage("invocation", "@bot thoughts?", 4, "dave");
  const fetchCalls: unknown[] = [];
  const message = {
    ...invocation,
    reference: { messageId: "target" },
    channel: {
      messages: {
        fetch: async (options: unknown) => {
          fetchCalls.push(options);
          return new Map([
            [after.id, after],
            [invocation.id, invocation],
            [target.id, target],
            [before.id, before],
          ]);
        },
      },
    },
    fetchReference: async () => target,
  };

  const result = await resolveDiscordContext(message as never, "thoughts?");

  assert.deepEqual(fetchCalls, [{ around: "target", limit: 7 }]);
  assert.ok(result.indexOf("alice") < result.indexOf("bob"));
  assert.ok(result.indexOf("bob") < result.indexOf("carol"));
  assert.match(result, /bob .*\[replied-to message\]/);
  assert.match(result, /the message being discussed/);
  assert.doesNotMatch(result, /@bot thoughts/);
  assert.match(result, /\[\/Discord reply context\]\n\nthoughts\?$/);
});

test("messages without a reply reference are unchanged", async () => {
  const message = { reference: null, channel: {} };
  assert.equal(await resolveDiscordContext(message as never, "hello"), "hello");
});

test("mention context includes the messages immediately preceding the invocation", async () => {
  const older = contextMessage("older", "first", 1, "alice");
  const newer = contextMessage("newer", "second", 2, "bob");
  const fetchCalls: unknown[] = [];
  const message = {
    id: "invocation",
    reference: null,
    channel: {
      messages: {
        fetch: async (options: unknown) => {
          fetchCalls.push(options);
          return new Map([[newer.id, newer], [older.id, older]]);
        },
      },
    },
  };

  const result = await resolveDiscordContext(message as never, "what do you think?", true);

  assert.deepEqual(fetchCalls, [{ before: "invocation", limit: 6 }]);
  assert.ok(result.indexOf("alice") < result.indexOf("bob"));
  assert.match(result, /^\[Recent Discord conversation\]/);
  assert.match(result, /\[\/Recent Discord conversation\]\n\nwhat do you think\?$/);
});

test("guild context is not fetched without the requester's history permission", async () => {
  let fetched = false;
  const message = {
    id: "invocation",
    author: { id: "requester" },
    reference: null,
    channel: {
      permissionsFor: (userId: string) => {
        assert.equal(userId, "requester");
        return { has: () => false };
      },
      messages: {
        fetch: async () => {
          fetched = true;
          return new Map();
        },
      },
    },
  };

  assert.equal(await resolveDiscordContext(message as never, "question", true), "question");
  assert.equal(fetched, false);
});

test("reply fetch failures are represented without dropping the prompt", async () => {
  const message = {
    id: "invocation",
    reference: { messageId: "target" },
    channel: { messages: { fetch: async () => { throw new Error("missing access"); } } },
  };
  const result = await resolveDiscordContext(message as never, "question");
  assert.match(result, /Could not fetch Discord reply context: missing access/);
  assert.match(result, /question$/);
});
