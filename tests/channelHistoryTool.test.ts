import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactTools } from "../src/common/artifactTools.js";
import { CHANNEL_SUMMARY_INSTRUCTIONS } from "../src/common/channelSummaryContract.js";

function runtime(options = {}) {
  return new ArtifactTools({ directory: "/tmp/history-run", workingDirectory: "/tmp" } as never, options);
}

test("history tool dispatch is scoped to the active run and capped", async () => {
  const calls: unknown[] = [];
  const tool = runtime({ resolveChannelHistory: async (args, signal) => {
    assert.equal(signal.aborted, false);
    calls.push(args);
    return "[Channel summary source] evidence";
  } });
  const args = { run_id: tool.id, range: "after_message", message_url: "https://discord.com/channels/1/2/1998" };
  await assert.rejects(tool.call("fetch_channel_history", { ...args, run_id: "old" }), /expired/);
  await assert.rejects(tool.call("fetch_channel_history", { ...args, requester: "other" }), /Invalid/);
  for (let i = 0; i < 3; i++) assert.match(String(await tool.call("fetch_channel_history", args)), /evidence/);
  await assert.rejects(tool.call("fetch_channel_history", args), /history call limit/);
  assert.equal(calls.length, 3);
  await tool.cancel();
  await assert.rejects(tool.call("fetch_channel_history", args));
});

test("history callback is unavailable outside supported runs", async () => {
  for (const options of [{}, ...["scheduled", "ephemeral"].map(contextProfile => ({ contextProfile, resolveChannelHistory: async () => { throw new Error("must not run"); } }))]) {
    const tool = runtime(options);
    await assert.rejects(tool.call("fetch_channel_history", { run_id: tool.id, range: "recent" }), /unavailable/);
    await tool.cancel();
  }
});

test("durable instructions direct natural language requests to the structured tool", () => {
  assert.match(CHANNEL_SUMMARY_INSTRUCTIONS, /fetch_channel_history/);
  assert.match(CHANNEL_SUMMARY_INSTRUCTIONS, /no exact wording or text order/);
  assert.match(CHANNEL_SUMMARY_INSTRUCTIONS, /when the URL appears first/);
  assert.match(CHANNEL_SUMMARY_INSTRUCTIONS, /all user constraints/);
});
