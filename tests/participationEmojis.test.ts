import assert from "node:assert/strict";
import test from "node:test";
import { Collection } from "discord.js";
import { DEFAULT_PARTICIPATION_EMOJIS, ChatParticipation, parseParticipationDecision, type ConversationMessage } from "../src/common/chatParticipation.js";
import { participationEmojis, reactWithParticipationEmoji } from "../src/common/discordParticipation.js";
import { assessParticipation } from "../scripts/participationEvaluation.js";
import type { ParticipationScenario } from "../scripts/fixtures/participationScenarios.js";

function guildMessage() {
  const emoji = (id: string, name: string, available = true, roles: string[] = []) => ({ id, name, available, roles: { cache: new Collection(roles.map(id => [id, { id }])) } });
  const guild = {
    members: { me: { roles: { cache: new Collection([["allowed", { id: "allowed" }]]) } } },
    emojis: { cache: new Collection([
      ["100", emoji("100", "party_parrot")],
      ["200", emoji("200", "unavailable", false)],
      ["300", emoji("300", "restricted", true, ["other"])],
      ["400", emoji("400", "role_celebration", true, ["allowed"])],
    ]) },
  };
  const sent: string[] = [];
  return { guild, sent, message: { guild, react: async (value: string) => { sent.push(value); } } };
}

test("catalog includes this server's usable emoji and Unicode fallbacks", () => {
  const { message, guild } = guildMessage();
  assert.deepEqual(participationEmojis(message as never), [...DEFAULT_PARTICIPATION_EMOJIS, { value: "100", name: "party_parrot" }, { value: "400", name: "role_celebration" }]);
  guild.emojis.cache.get("100")!.name = "renamed";
  assert.equal(participationEmojis(message as never).find(e => e.value === "100")?.name, "renamed");
  assert.deepEqual(participationEmojis({ guild: null }), DEFAULT_PARTICIPATION_EMOJIS);
});

test("reaction delivery rechecks deletion, availability and roles", async () => {
  const { message, guild, sent } = guildMessage();
  await reactWithParticipationEmoji(message as never, "100");
  guild.emojis.cache.delete("100");
  await reactWithParticipationEmoji(message as never, "100");
  guild.members.me.roles.cache.clear();
  await reactWithParticipationEmoji(message as never, "400");
  await reactWithParticipationEmoji(message as never, "200");
  await reactWithParticipationEmoji(message as never, "other-server-emoji");
  await reactWithParticipationEmoji(message as never, "👍");
  assert.deepEqual(sent, ["100", "👍"]);
});

test("custom emoji must be in the catalog supplied for the decision", () => {
  const raw = JSON.stringify({ action: "react", messageId: "1", emoji: "100" });
  assert.deepEqual(parseParticipationDecision(raw, ["1"]), { action: "ignore" });
  assert.deepEqual(parseParticipationDecision(raw, ["1"], [{ value: "100", name: "party_parrot" }]), JSON.parse(raw));
});

test("coordinator carries custom catalog through classification and reaction delivery", async t => {
  const sent: string[] = [];
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const catalog = [{ value: "100", name: "party_parrot" }];
  const coordinator = new ChatParticipation<ConversationMessage>({
    id: m => m.id, context: async messages => messages, emojis: () => catalog,
    classify: async prompt => {
      assert.deepEqual(JSON.parse(prompt).availableEmojis, catalog);
      return JSON.stringify({ action: "react", messageId: "1", emoji: "100" });
    },
    reply: async () => { assert.fail("reaction must not invoke answering model"); },
    react: async (_m, emoji) => { sent.push(emoji); finish(); }, onError: e => { throw e; },
  }, { debounceMs: 0, maxWaitMs: 0, cooldownMs: 0 });
  t.after(() => coordinator.stop());
  coordinator.enqueue("thread", { id: "1", authorId: "alice", authorName: "Alice", content: "Celebrate!", bot: false, attachmentCount: 0 }, false);
  await done;
  assert.deepEqual(sent, ["100"]);
});

const scenario: ParticipationScenario = {
  name: "follow-up", candidateIds: ["1", "2"], messages: [], replyCooldown: true, expectedActivity: true,
  expected: [{ action: "reply", messageId: "2", directed: true }],
};
test("evaluation catches wrong targets, direction and malformed output", () => {
  assert.equal(assessParticipation(JSON.stringify(scenario.expected[0]), scenario).passed, true);
  for (const decision of [
    { action: "reply", messageId: "1", directed: true },
    { action: "reply", messageId: "2", directed: false },
    { action: "reply", messageId: "2" },
  ]) assert.equal(assessParticipation(JSON.stringify(decision), scenario).passed, false);
  assert.equal(assessParticipation("invalid", { ...scenario, expected: [{ action: "ignore" }] }).valid, false);
});

test("evaluation checks requested custom emoji and cooldown activity", () => {
  const reaction: ParticipationScenario = { ...scenario, replyCooldown: false, reactionCooldown: true, expectedActivity: false,
    availableEmojis: [{ value: "100", name: "party" }, { value: "200", name: "sad" }],
    expected: [{ action: "react", messageId: "2", emoji: "100" }],
  };
  assert.equal(assessParticipation(JSON.stringify(reaction.expected[0]), reaction).passed, true);
  assert.equal(assessParticipation('{"action":"react","messageId":"2","emoji":"200"}', reaction).passed, false);
});
