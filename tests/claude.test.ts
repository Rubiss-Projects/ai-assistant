import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeQueryOptions, claudeToolDecision, configuredClaudeFastMode } from "../src/providers/claude.js";
import { providerChildEnvironment } from "../src/common/providerSecurity.js";

function workspace(t: test.TestContext): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ai-claude-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("shared Claude policy scopes files to the workspace and allows only host MCP servers", (t) => {
  const root = workspace(t);
  const allowed = (tool: string, input: unknown, github = false) => claudeToolDecision(root, tool, input, github).allow;

  assert.equal(allowed("Read", { file_path: join(root, "notes.md") }), true);
  assert.equal(allowed("Edit", { file_path: "src/index.ts" }), true);
  assert.equal(allowed("Read", { file_path: join(root, ".env") }), false);
  assert.equal(allowed("Write", { file_path: join(root, ".claude", "settings.json") }), false);
  assert.equal(allowed("Read", { file_path: "/etc/passwd" }), false);
  assert.equal(allowed("Read", {}), false);
  assert.equal(allowed("Glob", { pattern: "**/*.ts" }), true);
  assert.equal(allowed("Glob", { pattern: "../**/*" }), false);
  assert.equal(allowed("Glob", { pattern: "*", path: "/" }), false);
  assert.equal(allowed("Bash", { command: "env" }), false);
  assert.equal(allowed("Grep", { pattern: "TOKEN" }), false);
  assert.equal(allowed("Agent", {}), false);
  assert.equal(allowed("WebFetch", { url: "https://example.com" }), true);
  assert.equal(allowed("mcp__artifact_tools__attach_file", {}), true);
  assert.equal(allowed("mcp__github_contributions__open_pr", {}), false);
  assert.equal(allowed("mcp__github_contributions__open_pr", {}, true), true);
  assert.equal(allowed("mcp__other__anything", {}), false);
});

test("shared Claude options isolate settings and gate every tool through a blocking hook", (t) => {
  const root = workspace(t);
  const params = { workingDirectory: root, model: "claude-sonnet-5-5", effort: "medium" as const, fastMode: false, systemPrompt: "policy", mcpServers: {} };
  const shared = claudeQueryOptions(params, { AI_ASSISTANT_SECURITY_MODE: "shared", HOME: "/home/bot", DISCORD_TOKEN: "secret", ANTHROPIC_API_KEY: "key" });

  assert.deepEqual(shared.settingSources, []);
  assert.equal(shared.strictMcpConfig, true);
  assert.equal(shared.permissionMode, "default");
  assert.ok(Array.isArray(shared.tools) && !shared.tools.includes("Bash"));
  assert.equal(shared.hooks?.PreToolUse?.[0]?.onFailure, "block");
  assert.deepEqual(shared.env, { HOME: "/home/bot", ANTHROPIC_API_KEY: "key" });

  const unrestricted = claudeQueryOptions(params, { HOME: "/home/bot" });
  assert.equal(unrestricted.permissionMode, "bypassPermissions");
  assert.equal(unrestricted.settingSources, undefined);
  assert.equal(unrestricted.hooks, undefined);
});

test("Claude environment allowlist passes Claude credentials but not other providers' secrets", () => {
  const environment = providerChildEnvironment("claude", {
    AI_ASSISTANT_SECURITY_MODE: "shared", USER: "bot", CLAUDE_CODE_OAUTH_TOKEN: "oauth", CLAUDE_CONFIG_DIR: "/data/.claude",
    OPENAI_API_KEY: "openai", COPILOT_GITHUB_TOKEN: "gh",
  });
  assert.deepEqual(environment, { USER: "bot", CLAUDE_CODE_OAUTH_TOKEN: "oauth", CLAUDE_CONFIG_DIR: "/data/.claude" });
});

test("CLAUDE_FAST_MODE accepts only true or false", () => {
  assert.equal(configuredClaudeFastMode({}), false);
  assert.equal(configuredClaudeFastMode({ CLAUDE_FAST_MODE: "TRUE" }), true);
  assert.throws(() => configuredClaudeFastMode({ CLAUDE_FAST_MODE: "yes" }), /CLAUDE_FAST_MODE/);
});
