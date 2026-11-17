import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeQueryOptions, claudeToolDecision, configuredClaudeFastMode } from "../src/providers/claude.js";
import { providerChildEnvironment } from "../src/common/providerSecurity.js";
import { resolveSessionContext } from "../src/common/sessionContext.js";

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
  assert.deepEqual(shared.env, { HOME: "/home/bot", ANTHROPIC_API_KEY: "key", CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" });
  assert.deepEqual(shared.settings, { fastMode: false, autoMemoryEnabled: false });

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

test("providers without Sites support keep the no-external-writes boundary", (t) => {
  const previous = { mode: process.env.AI_ASSISTANT_SECURITY_MODE, sites: process.env.AI_ASSISTANT_ENABLE_SITES };
  t.after(() => {
    for (const [key, value] of [["AI_ASSISTANT_SECURITY_MODE", previous.mode], ["AI_ASSISTANT_ENABLE_SITES", previous.sites]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_SITES: "true" });

  assert.equal(resolveSessionContext().sitesEnabled, true);
  const claude = resolveSessionContext({ sitesSupported: false });
  assert.equal(claude.sitesEnabled, false);
  assert.doesNotMatch(claude.systemPrompt, /ChatGPT Sites/);
  assert.match(claude.systemPrompt, /External side effects are disabled/);
});

test("shared Claude denies the home-level Claude state file and its backups", (t) => {
  const root = workspace(t);
  for (const name of [".claude.json", ".Claude.JSON", ".claude.json.backup", "nested/.claude.json"]) {
    assert.equal(claudeToolDecision(root, "Read", { file_path: join(root, name) }, false).allow, false, name);
  }
  assert.equal(claudeToolDecision(root, "Read", { file_path: join(root, "claude.json") }, false).allow, true);
});

test("shared Claude rejects any overlap between the workspace and Claude state, including symlink aliases", (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  mkdirSync(join(root, "state"));
  symlinkSync(join(root, "state"), join(outside, "alias"));
  const params = { workingDirectory: root, model: "m", effort: "medium" as const, fastMode: false, systemPrompt: "", mcpServers: {} };
  const options = (dir: string) => claudeQueryOptions(params, { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: root, CLAUDE_CONFIG_DIR: dir });

  assert.throws(() => options(join(root, "state")), /must not overlap/);
  assert.throws(() => options(join(outside, "alias")), /must not overlap/);
  assert.throws(() => options("state"), /must be an absolute path/);
  const home = workspace(t);
  const nested = join(home, ".claude", "projects");
  mkdirSync(nested, { recursive: true });
  const nestedOptions = (env: Record<string, string>) => claudeQueryOptions({ ...params, workingDirectory: nested }, { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: nested, ...env });
  assert.throws(() => nestedOptions({ HOME: home }), /must not overlap/);
  assert.throws(() => nestedOptions({ CLAUDE_CONFIG_DIR: join(home, ".claude") }), /must not overlap/);
  assert.doesNotThrow(() => claudeQueryOptions({ ...params, workingDirectory: home }, { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: home, HOME: home }));
  assert.doesNotThrow(() => options(join(outside, "claude")));
});
