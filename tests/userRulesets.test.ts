import type { ChatInputCommandInteraction } from "discord.js";
import { handleRuleset } from "../src/handlers/slash/ruleset.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import { RulesetToolSessions, rulesetToolPrompt } from "../src/common/rulesetToolBridge.js";
import { RulesetTools, createRulesetToolRun } from "../src/common/rulesetTools.js";
import { USER_RULESET_LIMITS, UserInstructionStore } from "../src/common/userInstructionStore.js";
import { applyUserInstructions, previewUserInstructions, providerSystemPromptForUser } from "../src/utils/userInstructions.js";

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

async function withModeAsync<T>(mode: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.USER_INSTRUCTION_MODE;
  process.env.USER_INSTRUCTION_MODE = mode;
  try { return await action(); }
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

test("UserInstructionStore rejects enabled rulesets that would exceed the injected block limit", () => {
  const store = new UserInstructionStore(tempFile());
  const maxInstructions = "x".repeat(USER_RULESET_LIMITS.maxInstructionLength);

  store.set({ guildId: "g", targetUserId: "u", name: "a", instructions: maxInstructions, createdBy: "admin" });
  assert.throws(
    () => store.set({ guildId: "g", targetUserId: "u", name: "b", instructions: maxInstructions, createdBy: "admin" }),
    /User instruction block exceeds/,
  );

  const appendable = new UserInstructionStore(tempFile());
  appendable.set({ guildId: "g", targetUserId: "u", name: "a", instructions: "a".repeat(3850), createdBy: "admin" });
  appendable.set({ guildId: "g", targetUserId: "u", name: "b", instructions: "b".repeat(3850), createdBy: "admin" });
  assert.throws(
    () => appendable.append("g", "u", "a", "c".repeat(100), "admin"),
    /User instruction block exceeds/,
  );

  const enableable = new UserInstructionStore(tempFile());
  enableable.set({ guildId: "g", targetUserId: "u", name: "a", instructions: maxInstructions, createdBy: "admin" });
  enableable.set({ guildId: "g", targetUserId: "u", name: "b", instructions: maxInstructions, createdBy: "admin", enabled: false });
  assert.throws(
    () => enableable.setEnabled("g", "u", "b", true, "admin"),
    /User instruction block exceeds/,
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

test("providerSystemPromptForUser composes enabled rules without rewriting user text", () => {
  const store = new UserInstructionStore(tempFile());
  store.set({ guildId: "guild-1", targetUserId: "target", name: "hello-world", instructions: "When they say hello, say world.", createdBy: "admin" });

  const systemPrompt = withMode("admin_only", () =>
    providerSystemPromptForUser({ guildId: "guild-1", userId: "target", userDisplayName: "Target" }, store)
  );

  assert.match(systemPrompt, /Additional Discord user instructions/);
  assert.match(systemPrompt, /hello-world/);
  assert.match(systemPrompt, /When they say hello, say world/);
  assert.doesNotMatch(systemPrompt, /User message:\nhello/);
});

test("RulesetTools enforce host permissions and mutate the store for admins", async () => withModeAsync("admin_only", async () => {
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
}));

test("RulesetTools honor USER_INSTRUCTION_MODE management policies", async () => {
  const access = createAccessPolicy({ DISCORD_ADMIN_USERS: "admin" });

  await withModeAsync("off", async () => {
    const store = new UserInstructionStore(tempFile());
    const run = createRulesetToolRun();
    const tools = new RulesetTools(run, { access, requester: { userId: "111", guildId: "guild-1" }, guildId: "guild-1" }, store);
    await assert.rejects(
      tools.call("set_user_ruleset", { run_id: run.id, user: "222", name: "off-rule", instructions: "No-op." }),
      /unavailable/,
    );
    assert.equal(rulesetToolPrompt("hello", tools), "hello");
  });

  await withModeAsync("admin_only", async () => {
    const store = new UserInstructionStore(tempFile());
    const memberRun = createRulesetToolRun();
    const memberTools = new RulesetTools(memberRun, { access, requester: { userId: "111", guildId: "guild-1" }, guildId: "guild-1" }, store);
    await assert.rejects(
      memberTools.call("set_user_ruleset", { run_id: memberRun.id, user: "111", name: "self-rule", instructions: "Self." }),
      /permission/,
    );

    const adminRun = createRulesetToolRun();
    const adminTools = new RulesetTools(adminRun, { access, requester: { userId: "admin", guildId: "guild-1" }, guildId: "guild-1" }, store);
    await adminTools.call("set_user_ruleset", { run_id: adminRun.id, user: "222", name: "admin-rule", instructions: "Admin." });
    assert.equal(store.listForUser("guild-1", "222").length, 1);
  });

  await withModeAsync("admin_and_self", async () => {
    const store = new UserInstructionStore(tempFile());
    const memberRun = createRulesetToolRun();
    const memberTools = new RulesetTools(memberRun, { access, requester: { userId: "111", guildId: "guild-1" }, guildId: "guild-1" }, store);
    await memberTools.call("set_user_ruleset", { run_id: memberRun.id, user: "111", name: "self-rule", instructions: "Self." });
    await assert.rejects(
      memberTools.call("set_user_ruleset", { run_id: memberRun.id, user: "222", name: "ben-rule", instructions: "Ben." }),
      /permission/,
    );

    const adminRun = createRulesetToolRun();
    const adminTools = new RulesetTools(adminRun, { access, requester: { userId: "admin", guildId: "guild-1" }, guildId: "guild-1" }, store);
    await adminTools.call("set_user_ruleset", { run_id: adminRun.id, user: "111", name: "admin-self-rule", instructions: "Admin for Brian." });
    assert.deepEqual(
      store.listForUser("guild-1", "111").map((ruleset) => ruleset.name).sort(),
      ["admin-self-rule", "self-rule"],
    );
  });

  await withModeAsync("unfiltered", async () => {
    const store = new UserInstructionStore(tempFile());
    const brianRun = createRulesetToolRun();
    const brianTools = new RulesetTools(brianRun, { access, requester: { userId: "111", guildId: "guild-1" }, guildId: "guild-1" }, store);
    await brianTools.call("set_user_ruleset", { run_id: brianRun.id, user: "222", name: "brian-for-ben", instructions: "Brian can set Ben." });
    assert.equal(store.listForUser("guild-1", "222")[0].createdBy, "111");
  });
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
  await withModeAsync("admin_only", async () => {
    await sessions.run("session-a", {
      rulesetContext: { access, requester: { userId: "admin", guildId: "guild-1" }, guildId: "guild-1" },
    }, async (runtime) => {
      runId = runtime.id;
      const result = await client.callTool({ name: "set_user_ruleset", arguments: { run_id: runtime.id, user: "123", instructions: "When they say hello, say world." } });
      assert.equal(result.isError, undefined);
    });
  });

  assert.equal(new UserInstructionStore(file).listForUser("guild-1", "123").length, 1);
  const stale = await client.callTool({ name: "list_user_rulesets", arguments: { run_id: runId, user: "123" } });
  assert.equal(stale.isError, true);
});


test("UserInstructionStore rejects corrupt storage without overwriting it", () => {
  const file = tempFile();
  const store = new UserInstructionStore(file);
  for (const broken of ["{invalid", "{}", "[{}]"]) {
    fs.writeFileSync(file, broken);
    assert.throws(() => store.set({ guildId: "guild", targetUserId: "user", name: "rule", instructions: "Hello", createdBy: "admin" }));
    assert.equal(fs.readFileSync(file, "utf8"), broken);
    assert.throws(() => new UserInstructionStore(file));
  }
});

test("ruleset slash commands resolve storage after environment initialization", async () => withModeAsync("admin_only", async () => {
  const previous = process.env.USER_INSTRUCTION_RULESETS_FILE;
  const file = tempFile();
  process.env.USER_INSTRUCTION_RULESETS_FILE = file;
  try {
    const replies: unknown[] = [];
    let priority: number | null = 7;
    const values: Record<string, string> = { name: "tone", instructions: "Use short sentences." };
    const interaction = {
      guildId: "guild-1", user: { id: "admin" }, deferred: false,
      options: {
        getSubcommand: () => "set", getUser: () => ({ id: "123", toString: () => "<@123>" }),
        getString: (name: string) => values[name] ?? null, getInteger: () => priority,
      },
      deferReply: async () => { interaction.deferred = true; },
      editReply: async (content: unknown) => { replies.push(content); },
    };
    await handleRuleset(interaction as unknown as ChatInputCommandInteraction,
      { userId: "admin", guildId: "guild-1" }, createAccessPolicy({ DISCORD_ADMIN_USERS: "admin" }));
    assert.match(String(replies[0]), /Updated ruleset/);
    const store = new UserInstructionStore(file);
    assert.equal(store.get("guild-1", "123", "tone")?.instructions, values.instructions);
    priority = null;
    const runSlash = () => handleRuleset(interaction as unknown as ChatInputCommandInteraction,
      { userId: "admin", guildId: "guild-1" }, createAccessPolicy({ DISCORD_ADMIN_USERS: "admin" }));
    await runSlash();
    assert.equal(store.get("guild-1", "123", "tone")?.priority, 7);
    const runtime = new RulesetTools(createRulesetToolRun(), {
      access: createAccessPolicy({ DISCORD_ADMIN_USERS: "admin" }), requester: { userId: "admin", guildId: "guild-1" }, guildId: "guild-1",
    }, store);
    try {
      await runtime.call("set_user_ruleset", { run_id: runtime.id, user: "123", name: "tone", instructions: "Updated by a tool." });
      assert.equal(store.get("guild-1", "123", "tone")?.priority, 7);
    } finally { await runtime.close(); }
    delete values.name;
    await runSlash();
    values.instructions = "Use brief paragraphs.";
    await runSlash();
    const generated = store.listForUser("guild-1", "123").filter(rule => rule.name.startsWith("short-replies"));
    assert.deepEqual(generated.map(rule => rule.name), ["short-replies", "short-replies-2"]);
    assert.equal(generated[0].instructions, "Use short sentences.");
    assert.equal(generated[1].instructions, "Use brief paragraphs.");
  } finally {
    if (previous === undefined) delete process.env.USER_INSTRUCTION_RULESETS_FILE;
    else process.env.USER_INSTRUCTION_RULESETS_FILE = previous;
  }
}));
