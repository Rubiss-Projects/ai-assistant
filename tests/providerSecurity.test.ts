import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configuredSecurityMode,
  configuredSitesEnabled,
  pathIsWithin,
  providerChildEnvironment,
  resolveConfiguredWorkspace,
  SENSITIVE_DIRECTORY_DENY_GLOBS,
  SENSITIVE_PATH_DENY_GLOBS,
  secureSystemPrompt,
  setupSecurityMode,
  setupSitesEnabled,
  workspacePathIsAllowed,
} from "../src/common/providerSecurity.js";
import {
  copilotClientOptions,
  copilotWorkspaceMcpEnabled,
  createCopilotPermissionHandler,
} from "../src/providers/copilot.js";
import {
  CODEX_GITHUB_READ_ONLY_TOOLS,
  codexClientOptions,
  codexFilesystemPermissionOverride,
  codexThreadSecurityOptions,
  createCodexSessionTemporaryDirectory,
} from "../src/providers/codex.js";
import {
  openCodeBaseRunArguments,
  openCodeChildEnvironment,
  openCodeRequestPrompt,
  openCodeSecurityConfig,
} from "../src/providers/opencode.js";

test("security configuration preserves legacy installs and validates explicit values", () => {
  assert.equal(configuredSecurityMode({}), "unrestricted");
  assert.equal(configuredSecurityMode({ AI_ASSISTANT_SECURITY_MODE: "shared" }), "shared");
  assert.equal(configuredSitesEnabled({}), false);
  assert.equal(configuredSitesEnabled({ AI_ASSISTANT_ENABLE_SITES: "true" }), true);
  assert.match(
    secureSystemPrompt(undefined, {
      AI_ASSISTANT_SECURITY_MODE: "shared",
      AI_ASSISTANT_ENABLE_SITES: "true",
    }),
    /except for ChatGPT Sites/,
  );
  assert.throws(
    () => configuredSecurityMode({ AI_ASSISTANT_SECURITY_MODE: "maybe" }),
    /Invalid AI_ASSISTANT_SECURITY_MODE/,
  );
  assert.throws(
    () => configuredSitesEnabled({ AI_ASSISTANT_ENABLE_SITES: "yes" }),
    /Invalid AI_ASSISTANT_ENABLE_SITES/,
  );
  assert.equal(setupSecurityMode(), "shared");
  assert.equal(setupSecurityMode("unrestricted"), "unrestricted");
  assert.equal(setupSitesEnabled(), false);
  assert.equal(setupSitesEnabled("true"), true);
});

test("shared provider child environments never inherit Discord or MCP secrets", () => {
  const source = {
    AI_ASSISTANT_SECURITY_MODE: "shared",
    PATH: "/usr/bin",
    HOME: "/data",
    CODEX_HOME: "/data/.codex",
    OPENAI_BASE_URL: "https://gateway.example/v1",
    DISCORD_TOKEN: "discord-secret",
    DISCORD_APP_ID: "app-id",
    MCP_INPUT_GITHUB_TOKEN: "mcp-secret",
    OPENAI_API_KEY: "openai-key",
    ANTHROPIC_API_KEY: "anthropic-key",
  };

  const codex = providerChildEnvironment("codex", source);
  assert.equal(codex.CODEX_HOME, "/data/.codex");
  assert.equal(codex.OPENAI_BASE_URL, "https://gateway.example/v1");
  assert.equal(codex.DISCORD_TOKEN, undefined);
  assert.equal(codex.OPENAI_API_KEY, undefined);
  assert.equal(codex.MCP_INPUT_GITHUB_TOKEN, undefined);

  const opencode = providerChildEnvironment("opencode", source);
  assert.equal(opencode.OPENAI_API_KEY, "openai-key");
  assert.equal(opencode.ANTHROPIC_API_KEY, "anthropic-key");
  assert.equal(opencode.DISCORD_TOKEN, undefined);
});

test("unrestricted provider child environments preserve legacy inheritance", () => {
  const source = {
    AI_ASSISTANT_SECURITY_MODE: "unrestricted",
    PATH: "/usr/bin",
    DISCORD_TOKEN: "discord-secret",
    MCP_INPUT_GITHUB_TOKEN: "mcp-secret",
  };
  const environment = providerChildEnvironment("codex", source);
  assert.equal(environment.DISCORD_TOKEN, "discord-secret");
  assert.equal(environment.MCP_INPUT_GITHUB_TOKEN, "mcp-secret");
});

test("configured workspace roots reject paths outside their boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-workspace-root-"));
  const workspace = join(root, "project");
  const credentials = join(root, ".codex");
  const outside = mkdtempSync(join(tmpdir(), "ai-workspace-outside-"));
  mkdirSync(workspace);
  mkdirSync(credentials);

  const source = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: root };
  assert.equal(resolveConfiguredWorkspace(workspace, source), workspace);
  assert.throws(
    () => resolveConfiguredWorkspace(outside, source),
    /configured root/,
  );
  assert.throws(
    () => resolveConfiguredWorkspace(credentials, source),
    /Credential and provider state/,
  );
  assert.equal(pathIsWithin(root, workspace), true);
  assert.equal(pathIsWithin(root, outside), false);
  assert.equal(
    resolveConfiguredWorkspace(outside, {
      AI_ASSISTANT_SECURITY_MODE: "unrestricted",
      AI_ASSISTANT_WORKSPACE_ROOT: root,
    }),
    outside,
  );
  assert.equal(
    resolveConfiguredWorkspace(process.cwd(), { AI_ASSISTANT_SECURITY_MODE: "shared" }),
    process.cwd(),
  );
  assert.throws(
    () => resolveConfiguredWorkspace(outside, { AI_ASSISTANT_SECURITY_MODE: "shared" }),
    /configured root/,
  );
});

test("workspace policy allows source edits but denies credentials and traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-workspace-policy-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
  writeFileSync(join(root, ".codex", "token.txt"), "SECRET=value\n");
  symlinkSync(join(root, ".codex"), join(root, "config"), "junction");

  assert.equal(workspacePathIsAllowed(root, "src/index.ts"), true);
  assert.equal(workspacePathIsAllowed(root, "src/new.ts"), true);
  assert.equal(workspacePathIsAllowed(root, ".env"), false);
  assert.equal(workspacePathIsAllowed(root, ".codex/auth.json"), false);
  assert.equal(workspacePathIsAllowed(root, "../auth.json"), false);
  assert.equal(workspacePathIsAllowed(root, "config/token.txt"), false);
});

test("Copilot approves workspace files and read-only MCP, but rejects shell and mutations", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-copilot-policy-"));
  const decide = createCopilotPermissionHandler(root);
  const invocation = { sessionId: "test" };

  assert.equal((await decide({ kind: "read", path: "README.md", intention: "read" }, invocation)).kind, "approve-once");
  assert.equal((await decide({ kind: "write", fileName: "src/new.ts", diff: "", intention: "edit", canOfferSessionApproval: false }, invocation)).kind, "approve-once");
  assert.equal((await decide({ kind: "read", path: "../.codex/auth.json", intention: "read" }, invocation)).kind, "reject");
  assert.equal((await decide({ kind: "mcp", serverName: "github", toolName: "get_repo", toolTitle: "Get repo", readOnly: true }, invocation)).kind, "approve-once");
  assert.equal((await decide({ kind: "mcp", serverName: "github", toolName: "create_pull_request", toolTitle: "Create PR", readOnly: false }, invocation)).kind, "reject");
  assert.equal((await decide({ kind: "shell", fullCommandText: "git push", intention: "publish", commands: [], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false }, invocation)).kind, "reject");
});

test("Copilot security mode switches between isolated and legacy client configuration", () => {
  const shared = copilotClientOptions({
    AI_ASSISTANT_SECURITY_MODE: "shared",
    HOME: "/data",
    DISCORD_TOKEN: "discord-secret",
  });
  assert.equal(shared?.mode, "empty");
  assert.equal(shared?.env?.DISCORD_TOKEN, undefined);

  const unrestricted = copilotClientOptions({
    AI_ASSISTANT_SECURITY_MODE: "unrestricted",
    GH_TOKEN: "github-token",
    DISCORD_TOKEN: "discord-secret",
  });
  assert.equal(unrestricted?.gitHubToken, "github-token");
  assert.equal(unrestricted?.mode, undefined);
  assert.equal(unrestricted?.env, undefined);
  assert.equal(copilotWorkspaceMcpEnabled({ AI_ASSISTANT_SECURITY_MODE: "shared" }), false);
  assert.equal(copilotWorkspaceMcpEnabled({ AI_ASSISTANT_SECURITY_MODE: "unrestricted" }), true);
});

test("Codex shared mode enables only known GitHub read tools and clears personal MCP servers", () => {
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const previousSites = process.env.AI_ASSISTANT_ENABLE_SITES;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_ENABLE_SITES = "false";
  process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
  const isolatedTemp = mkdtempSync(join(tmpdir(), "ai-codex-session-"));
  const options = codexClientOptions(isolatedTemp);
  assert.throws(() => codexClientOptions(), /isolated temporary directory/);
  if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
  else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  if (previousSites === undefined) delete process.env.AI_ASSISTANT_ENABLE_SITES;
  else process.env.AI_ASSISTANT_ENABLE_SITES = previousSites;
  if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousBaseUrl;
  const config = options.config as Record<string, any>;
  const apps = config.apps as Record<string, any>;

  assert.equal((config.features as Record<string, boolean>).plugins, false);
  assert.equal((config.features as Record<string, boolean>).hooks, false);
  assert.equal((config.features as Record<string, boolean>).network_proxy, false);
  assert.equal(apps._default.enabled, false);
  assert.equal(apps.github.enabled, true);
  assert.equal(apps.github.default_tools_enabled, false);
  assert.equal(apps.github.destructive_enabled, false);
  assert.deepEqual(Object.keys(apps.github.tools).sort(), [...CODEX_GITHUB_READ_ONLY_TOOLS].sort());
  assert.ok(options.configOverrides?.includes("mcp_servers={}"));
  assert.ok(
    options.configOverrides?.includes("permissions.discord-bot.network={enabled=false}"),
  );
  assert.equal(options.env?.DISCORD_TOKEN, undefined);
  assert.equal(options.env?.TMPDIR, isolatedTemp);
  assert.equal(options.baseUrl, "https://gateway.example/v1");
  const filesystemOverride = codexFilesystemPermissionOverride();
  assert.equal(filesystemOverride.includes('":slash_tmp"="write"'), false);
  for (const glob of SENSITIVE_PATH_DENY_GLOBS) {
    assert.match(filesystemOverride, new RegExp(`${glob.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^,}]*deny`));
  }
  assert.match(filesystemOverride, /"\.\*"="deny"/);
  assert.match(filesystemOverride, /"AUTH\.JSON"="deny"/);
  assert.equal(filesystemOverride.includes('"**/.env.example"="write"'), false);
});

test("Codex shared sessions receive distinct private temporary directories", () => {
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  const first = createCodexSessionTemporaryDirectory();
  const second = createCodexSessionTemporaryDirectory();
  try {
    assert.notEqual(first, second);
    assert.equal(codexClientOptions(first).env?.TMPDIR, first);
    assert.equal(codexClientOptions(second).env?.TMPDIR, second);
  } finally {
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
    else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  }
});

test("Codex can explicitly enable Sites without enabling other connected apps", () => {
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const previousSites = process.env.AI_ASSISTANT_ENABLE_SITES;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_ENABLE_SITES = "true";
  const options = codexClientOptions(mkdtempSync(join(tmpdir(), "ai-codex-sites-session-")));
  if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
  else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  if (previousSites === undefined) delete process.env.AI_ASSISTANT_ENABLE_SITES;
  else process.env.AI_ASSISTANT_ENABLE_SITES = previousSites;

  const config = options.config as Record<string, any>;
  const apps = config.apps as Record<string, any>;
  assert.equal((config.features as Record<string, boolean>).plugins, true);
  assert.equal((config.features as Record<string, boolean>).remote_plugin, false);
  assert.equal(apps._default.enabled, false);
  assert.equal(apps.sites.enabled, true);
  assert.equal(apps.sites.default_tools_enabled, true);
  assert.equal(apps.sites.destructive_enabled, false);
  assert.equal(apps.github.destructive_enabled, false);
});

test("Codex unrestricted mode preserves legacy client configuration", () => {
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const previousPrompt = process.env.AI_ASSISTANT_SYSTEM_PROMPT;
  const previousPromptFile = process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT;
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  const options = codexClientOptions();
  if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
  else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  if (previousPrompt === undefined) delete process.env.AI_ASSISTANT_SYSTEM_PROMPT;
  else process.env.AI_ASSISTANT_SYSTEM_PROMPT = previousPrompt;
  if (previousPromptFile === undefined) delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  else process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE = previousPromptFile;

  assert.equal(options.env, undefined);
  assert.match(String(options.config?.developer_instructions), /\[\[artifact:/);
  assert.equal(options.configOverrides, undefined);
  assert.deepEqual(
    codexThreadSecurityOptions({ AI_ASSISTANT_SECURITY_MODE: "unrestricted" }),
    { sandboxMode: "danger-full-access", networkAccessEnabled: true },
  );
  assert.deepEqual(codexThreadSecurityOptions({ AI_ASSISTANT_SECURITY_MODE: "shared" }), {});
});

test("OpenCode shared mode is deny-by-default with no shell, plugins, external paths, or MCP fallback", () => {
  const config = openCodeSecurityConfig() as Record<string, any>;
  const permission = config.permission as Record<string, any>;
  assert.equal(permission["*"], "deny");
  assert.equal(permission.bash, "deny");
  assert.equal(permission.external_directory, "deny");
  assert.equal(permission.grep, "deny");
  assert.equal(permission.edit["*"], "allow");
  assert.equal(permission.edit["**/.*/**"], "deny");
  assert.equal(permission.edit["AUTH.JSON"], "deny");
  assert.equal(permission.edit["**/AUTH.JSON"], "deny");
  assert.equal(permission.edit[".env.example"], "allow");
  assert.equal(permission.edit["**/.env.example"], undefined);
  assert.deepEqual(permission.edit, permission.read);
  const openCodeRuleOrder = Object.keys(permission.edit);
  for (const directoryGlob of SENSITIVE_DIRECTORY_DENY_GLOBS) {
    assert.ok(
      openCodeRuleOrder.indexOf(".env.example") < openCodeRuleOrder.indexOf(directoryGlob),
    );
  }
  assert.deepEqual(config.plugin, []);

  const env = openCodeChildEnvironment({
    AI_ASSISTANT_SECURITY_MODE: "shared",
    PATH: "/usr/bin",
    DISCORD_TOKEN: "discord-secret",
  });
  assert.equal(env.DISCORD_TOKEN, undefined);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), config);
});

test("OpenCode unrestricted mode restores its inherited environment and normal config", () => {
  const env = openCodeChildEnvironment({
    AI_ASSISTANT_SECURITY_MODE: "unrestricted",
    DISCORD_TOKEN: "discord-secret",
  });
  assert.equal(env.DISCORD_TOKEN, "discord-secret");
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(
    openCodeBaseRunArguments({ AI_ASSISTANT_SECURITY_MODE: "unrestricted" }).includes("--pure"),
    false,
  );
  assert.equal(
    openCodeBaseRunArguments({ AI_ASSISTANT_SECURITY_MODE: "shared" }).includes("--pure"),
    true,
  );
});

test("OpenCode shared mode includes operator instructions exactly once", () => {
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const previousPrompt = process.env.AI_ASSISTANT_SYSTEM_PROMPT;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "operator-marker";
  try {
    const prompt = openCodeRequestPrompt("user request");
    assert.equal(prompt.match(/operator-marker/g)?.length, 1);
    assert.match(prompt, /External side effects are disabled/);
    assert.match(prompt, /user request/);
  } finally {
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
    else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
    if (previousPrompt === undefined) delete process.env.AI_ASSISTANT_SYSTEM_PROMPT;
    else process.env.AI_ASSISTANT_SYSTEM_PROMPT = previousPrompt;
  }
});
