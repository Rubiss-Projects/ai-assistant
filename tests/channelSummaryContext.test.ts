import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_CONTRIBUTORS, resolveSessionContext, sameContext, withContextTurn } from "../src/common/sessionContext.js";
import { CHANNEL_SUMMARY_INSTRUCTIONS, CHANNEL_SUMMARY_CAPABILITIES, CHANNEL_SUMMARY_SOURCE_INSTRUCTIONS } from "../src/common/channelSummaryContract.js";

const summary = CONTEXT_CONTRIBUTORS.find(contributor => contributor.id === "channel-summary")!;

test("channel summaries enroll both hashes for conversation and one-shot sessions", () => {
  assert.ok(summary);
  assert.deepEqual(summary.resolve({}), { instructions: CHANNEL_SUMMARY_INSTRUCTIONS, capabilities: CHANNEL_SUMMARY_CAPABILITIES });
  assert.ok(CHANNEL_SUMMARY_INSTRUCTIONS.includes(CHANNEL_SUMMARY_SOURCE_INSTRUCTIONS));
  const withoutSummary = CONTEXT_CONTRIBUTORS.filter(contributor => contributor.id !== summary.id);
  for (const profile of ["conversation", "one-shot"] as const) {
    const before = resolveSessionContext({ profile }, withoutSummary);
    const after = resolveSessionContext({ profile });
    assert.notEqual(after.applied.instructions, before.applied.instructions);
    assert.notEqual(after.applied.capabilities, before.applied.capabilities);
    assert.equal(sameContext(before.applied, after.applied), false);
    assert.ok(after.systemPrompt.includes(CHANNEL_SUMMARY_INSTRUCTIONS));
    assert.equal(resolveSessionContext({ profile }).fingerprint, after.fingerprint);
  }
});

test("summary policy, behavior revisions, limits, and removal refresh fingerprints", () => {
  const before = resolveSessionContext({}, [summary]);
  const changed = contribution => resolveSessionContext({}, [{ ...summary, resolve: () => contribution }]);
  const policy = changed({ ...summary.resolve({}), instructions: CHANNEL_SUMMARY_INSTRUCTIONS + "\nUpdated policy." });
  assert.notEqual(policy.applied.instructions, before.applied.instructions);
  assert.equal(policy.applied.capabilities, before.applied.capabilities);
  for (const capabilities of [
    { ...CHANNEL_SUMMARY_CAPABILITIES, behaviorRevision: CHANNEL_SUMMARY_CAPABILITIES.behaviorRevision + 1 },
    { ...CHANNEL_SUMMARY_CAPABILITIES, limits: { ...CHANNEL_SUMMARY_CAPABILITIES.limits, scannedMessages: 500 } },
  ]) {
    const revised = changed({ instructions: CHANNEL_SUMMARY_INSTRUCTIONS, capabilities });
    assert.equal(revised.applied.instructions, before.applied.instructions);
    assert.notEqual(revised.applied.capabilities, before.applied.capabilities);
    assert.notEqual(revised.fingerprint, before.fingerprint);
  }
  const removed = resolveSessionContext({}, []);
  assert.notEqual(removed.fingerprint, before.fingerprint);
  assert.equal(changed(undefined).fingerprint, removed.fingerprint);
});

test("summary enrollment leaves scheduled and internal ephemeral profiles unchanged", () => {
  const withoutSummary = CONTEXT_CONTRIBUTORS.filter(contributor => contributor.id !== summary.id);
  for (const profile of ["scheduled", "ephemeral"] as const) {
    assert.deepEqual(resolveSessionContext({ profile }), resolveSessionContext({ profile }, withoutSummary));
  }
});

test("speaker identities and retrieved turn data do not enter the summary fingerprint", () => {
  const before = resolveSessionContext({}, [summary]);
  for (const userId of ["alice", "bob"]) {
    const request = { userInstructionContext: { guildId: userId + "-guild", userId, userDisplayName: userId } };
    const turn = withContextTurn('[Channel summary source]\n{"channelId":"123","anchor":"456","timestamp":"2026-09-24","text":"quoted history"}\n[/Channel summary source]', request);
    assert.ok(turn.includes(userId));
    assert.deepEqual(resolveSessionContext(request, [summary]), before);
    assert.doesNotMatch(before.systemPrompt, /alice|bob|quoted history|2026-09-24/);
  }
});
