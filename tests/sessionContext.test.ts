import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextFingerprint, resolveSessionContext, withContextTurn, type ContextContributor } from "../src/common/sessionContext.js";
import { SessionStore } from "../src/common/sessionStore.js";
import { UserInstructionStore } from "../src/common/userInstructionStore.js";
import { githubContributionTools } from "../src/common/githubContributionToolDefinitions.js";

test("server review enablement refreshes existing shared context and removes tools when disabled", t => {
  const values = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "false" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, values);
  const before = resolveSessionContext();
  const oneShot = resolveSessionContext({ profile: "one-shot" });
  assert(!githubContributionTools().some(tool => tool.name === "github_contribution_review"));
  process.env.AI_ASSISTANT_ENABLE_CODEX_REVIEWS = "true";
  const enabled = resolveSessionContext();
  assert.notEqual(enabled.applied.instructions, before.applied.instructions);
  assert.notEqual(enabled.applied.capabilities, before.applied.capabilities);
  assert.match(enabled.systemPrompt, /Server-side Codex review is enabled/);
  assert(githubContributionTools().some(tool => tool.name === "github_contribution_review"));
  assert.equal(resolveSessionContext({ profile: "one-shot" }).fingerprint, oneShot.fingerprint);
  process.env.AI_ASSISTANT_ENABLE_CODEX_REVIEWS = "false";
  assert.equal(resolveSessionContext().fingerprint, before.fingerprint);
});

test("operator contribution limits refresh shared instructions and capabilities, not one-shot sessions", t => {
  const values = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true", GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT: "20", CODEX_REVIEW_LIMIT: "20" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, values);
  const initial = resolveSessionContext(), oneShot = resolveSessionContext({ profile: "one-shot" });
  process.env.GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT = "2";
  const finite = resolveSessionContext();
  assert.notEqual(finite.applied.instructions, initial.applied.instructions);
  assert.notEqual(finite.applied.capabilities, initial.applied.capabilities);
  assert.match(finite.systemPrompt, /2 publish attempts/);
  process.env.CODEX_REVIEW_LIMIT = "0";
  const unlimited = resolveSessionContext();
  assert.notEqual(unlimited.applied.instructions, finite.applied.instructions);
  assert.notEqual(unlimited.applied.capabilities, finite.applied.capabilities);
  assert.match(unlimited.systemPrompt, /unlimited review attempts per PR/);
  assert.match(unlimited.systemPrompt, /stop requesting reviews as soon as the current head has a completed review with no remaining actionable findings/);
  assert.equal(resolveSessionContext({ profile: "one-shot" }).fingerprint, oneShot.fingerprint);
  process.env.GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT = " ";
  delete process.env.CODEX_REVIEW_LIMIT;
  assert.equal(resolveSessionContext().fingerprint, initial.fingerprint);
});

test("context fingerprints track instruction removal and tool contracts independently", () => {
  let instructions = "Be brief.";
  let description = "Read a public page.";
  const contributors: ContextContributor[] = [
    { id: "operator", profiles: ["conversation"], resolve: () => ({ instructions }) },
    { id: "browser", profiles: ["conversation"], resolve: () => ({ capabilities: [{ name: "browse", description, inputSchema: { type: "object" } }] }) },
  ];
  const initial = resolveSessionContext({}, contributors);
  assert.equal(resolveSessionContext({}, contributors).fingerprint, initial.fingerprint);
  description = "Render a public page.";
  const toolsChanged = resolveSessionContext({}, contributors);
  assert.equal(toolsChanged.applied.instructions, initial.applied.instructions);
  assert.notEqual(toolsChanged.applied.capabilities, initial.applied.capabilities);
  instructions = "";
  const removed = resolveSessionContext({}, contributors);
  assert.notEqual(removed.applied.instructions, toolsChanged.applied.instructions);
  assert.equal(removed.systemPrompt, "");
  assert.equal(resolveSessionContext({ profile: "ephemeral" }, contributors).systemPrompt, "");
  assert.equal(contextFingerprint({ b: 2, a: { z: 3, b: 1 } }), contextFingerprint({ a: { b: 1, z: 3 }, b: 2 }));
  assert.throws(() => resolveSessionContext({}, [...contributors, contributors[0]]), /Duplicate/);
});

test("operator file edits and scoped rulesets refresh while speaker names remain per-turn", t => {
  const dir = mkdtempSync(join(tmpdir(), "context-contributors-"));
  const names = ["AI_ASSISTANT_SYSTEM_PROMPT_FILE", "USER_INSTRUCTION_RULESETS_FILE", "USER_INSTRUCTION_MODE"] as const;
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
  process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE = join(dir, "prompt.txt");
  process.env.USER_INSTRUCTION_RULESETS_FILE = join(dir, "rules.json");
  process.env.USER_INSTRUCTION_MODE = "admin_only";
  writeFileSync(process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE, "FIRST_POLICY");
  const request = { userInstructionContext: { userId: "alice", guildId: "guild", userDisplayName: "Alice" } };
  const first = resolveSessionContext(request);
  const renamed = { userInstructionContext: { ...request.userInstructionContext, userDisplayName: "Renamed" } };
  assert.equal(resolveSessionContext(renamed).fingerprint, first.fingerprint);
  assert.match(withContextTurn("hello", renamed), /Renamed/);
  writeFileSync(process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE, "SECOND_POLICY");
  const second = resolveSessionContext(request);
  assert.notEqual(second.fingerprint, first.fingerprint);
  const store = new UserInstructionStore();
  store.set({ guildId: "guild", targetUserId: "alice", name: "brief", instructions: "ALICE_RULE", createdBy: "admin" });
  const alice = resolveSessionContext(request);
  assert.match(alice.systemPrompt, /ALICE_RULE/);
  assert.doesNotMatch(resolveSessionContext({ userInstructionContext: { userId: "bob", guildId: "guild" } }).systemPrompt, /ALICE_RULE/);
  assert.equal(resolveSessionContext({ ...request, profile: "ephemeral" }).rulesetsEnabled, false);
  process.env.USER_INSTRUCTION_MODE = "off";
  assert.doesNotMatch(resolveSessionContext(request).systemPrompt, /ALICE_RULE/);
  assert.notEqual(resolveSessionContext(request).applied.capabilities, alice.applied.capabilities);
});

test("session metadata migrates legacy IDs and keeps handoffs until acknowledged", () => {
  const file = join(mkdtempSync(join(tmpdir(), "context-store-")), "sessions.json");
  writeFileSync(file, JSON.stringify({ conversation: "old-thread" }));
  const store = new SessionStore("test", file);
  assert.deepEqual(store.getState("conversation"), { sessionId: "old-thread" });
  const context = { instructions: "instructions-v2", capabilities: "tools-v1" };
  store.set("conversation", "new-thread", context, "Historical facts.");
  const restarted = new SessionStore("test", file);
  assert.equal(restarted.getState("conversation")?.handoff, "Historical facts.");
  restarted.set("conversation", "new-thread", context);
  assert.equal(restarted.getState("conversation")?.handoff, undefined);
  assert.equal(new SessionStore("test", file).get("conversation"), "new-thread");
  mkdirSync(`${file}.tmp`);
  assert.throws(() => restarted.set("conversation", "failed-thread", context));
  assert.equal(restarted.get("conversation"), "new-thread");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).conversation.sessionId, "new-thread");
});
