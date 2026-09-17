import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import { RulesetToolSessions } from "../src/common/rulesetToolBridge.js";
import { RulesetTools, createRulesetToolRun } from "../src/common/rulesetTools.js";
import { UserInstructionStore } from "../src/common/userInstructionStore.js";
import { applyUserInstructions, previewUserInstructions } from "../src/utils/userInstructions.js";

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-rulesets-"));
  return path.join(dir, "rules.json");
}

function withMode<T>(mode: string, action: () => T): T {
  const previous = process.env.USER_INSTRUCTION_MODE;
  process.env.USER_INSTRUCTION_MODE = mode;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.USER_INSTRUCTION_MODE;
    else process.env.USER_INSTRUCTION_MODE = previous;
  }
}

test("UserInstructionStore persists, replaces, disables, deletes, and clears rulesets", () => {
  const file = tempFile();
  const store = new UserInstructionStore(file);
  const first = store.set({ guildId: "guild-1", targetUserId: "target", name: "tone", instructions: "Say world.", createdBy: "admin" });
  assert.equal(first.enabled, true);
  assert.equal(new UserInstructionStore(file).listForUser("guild-1", "target").length, 1);
  store.set({ guildId: "guild-1", targetUserId: "target", name: "tone", instructions: "Say hello.", createdBy: "admin-2" });
  assert.equal(store.listForUser("guild-1", "target")[0].instructions, "Say hello.");
  store.setEnabled("guild-1", "target", "tone", false, "admin");
  assert.equal(store.listForUser("guild-1", "target").length, 0);
  assert.equal(store.listForUser("guild-1", "target", true).length, 1);
  assert.equal(store.delete("guild-1", "target", "tone"), true);
  store.set({ guildId: "guild-1", targetUserId: "target", name: "a", instructions: "A", createdBy: "admin" });
  store.set({ guildId: "guild-1", targetUserId: "target", name: "b", instructions: "B", createdBy: "admin" });
  assert.equal(store.clear("guild-1", "target"), 2);
});

test("UserInstructionStore reloads before reads and writes so separate managers do not clobber each other", () => {
  const file = tempFile();
  const slashLikeStore = new UserInstructionStore(file);
  const toolLikeStore = new UserInstructionStore(file);

  toolLikeStore.set({ guildId: "guild-1", targetUserId: "target", name: "tool-rule", instructions: "Created by tool.", createdBy: "admin" });
  assert.equal(slashLikeStore.listForUser("guild-1", "target").map((ruleset) => ruleset.name).join(","), "tool-rule");

  slashLikeStore.set({ guildId: "guild-1", targetUserId: "target", name: "slash-rule", instructions: "Created by slash.", createdBy: "admin" });
  assert.deepEqual(
    new UserInstructionStore(file).listForUser("guild-1", "target").map((ruleset) => ruleset.name).sort(),
    ["slash-rule", "tool-rule"],
  );
});

test("applyUserInstructions injects enabled rules only when configured", () => {
  const store = new UserInstructionStore(tempFile());
  store.set({ guildId: "guild-1", targetUserId: "target", name: "hello-world", instructions: "When they say hello, say world.", createdBy: "admin" });
  store.set({ guildId: "guild-1", targetUserId: "target", name: "disabled", instructions: "Do not include.", createdBy: "admin", enabled: false });
  assert.equal(applyUserInstructions("hello", { guildId: "guild-1", userId: "target" }, store), "hello");
  const injected = withMode("admin_only", () => applyUserInstructions("hello", { guildId: "guild-1", userId: "target", userDisplayName: "Target" }, store));
  assert.match(injected, /Additional Discord user instructions/);
  assert.match(injected, /hello-world/);
  assert.doesNotMatch(injected, /Do not include/);
  assert.match(previewUserInstructions({ guildId: "guild-1", userId: "target" }, false, store), /say world/i);
});

test("RulesetTools enforce host permissions and mutate the store for admins", async () => {
  const file = tempFile();
  const store = new UserInstructionStore(file);
  const access = createAccessPolicy({ DISCORD_ADMIN_USERS: "admin" });
  const adminRun = createRulesetToolRun();
  const adminTools = new RulesetTools(adminRun, { access, requester: { userId: "admin", guildId: "guild-1" }, guildId: "guild-1" }, store);
  const deniedRun = createRulesetToolRun();
  const deniedTools = new RulesetTools(deniedRun, { access, requester: { userId: "member", guildId: "guild-1" }, guildId: "guild-1" }, store);

  await assert.rejects(
    deniedTools.call("set_user_ruleset", { run_id: deniedRun.id, user: "123", name: "hello-world", instructions: "Say world." }),
    /permission/,
  );

  const result = await adminTools.call("set_user_ruleset", { run_id: adminRun.id, user: "<@123>", instructions: "When they say hello, say world." }) as { ruleset: { name: string } };
  assert.equal(result.ruleset.name, "hello-world");
  assert.equal(store.listForUser("guild-1", "123").length, 1);
  await adminTools.close();
  await assert.rejects(
    adminTools.call("list_user_rulesets", { run_id: adminRun.id, user: "123" }),
    /expired|aborted|inactive/i,
  );
});

test("ruleset MCP transport lists tools, mutates during active runs, and rejects stale calls", async (t) => {
  const file = tempFile();
  const previousFile = process.env.USER_INSTRUCTION_RULESETS_FILE;
  process.env.USER_INSTRUCTION_RULESETS_FILE = file;
  t.after(() => {
    if (previousFile === undefined) delete process.env.USER_INSTRUCTION_RULESETS_FILE;
    else process.env.USER_INSTRUCTION_RULESETS_FILE = previousFile;
  });
  const sessions = new RulesetToolSessions();
  t.after(() => sessions.shutdown());
  const config = await sessions.config("session-a");
  const client = new Client({ name: "ruleset-test", version: "1" });
  await client.connect(new StdioClientTransport({ ...config, stderr: "pipe" }));
  t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "set_user_ruleset"));

  const access = createAccessPolicy({ DISCORD_ADMIN_USERS: "admin" });
  let runId = "";
  await sessions.run("session-a", {
    rulesetContext: { access, requester: { userId: "admin", guildId: "guild-1" }, guildId: "guild-1" },
  }, async (runtime) => {
    runId = runtime.id;
    const result = await client.callTool({ name: "set_user_ruleset", arguments: { run_id: runtime.id, user: "123", instructions: "When they say hello, say world." } });
    assert.equal(result.isError, undefined);
  });

  assert.equal(new UserInstructionStore(file).listForUser("guild-1", "123").length, 1);
  const stale = await client.callTool({ name: "list_user_rulesets", arguments: { run_id: runId, user: "123" } });
  assert.equal(stale.isError, true);
});
