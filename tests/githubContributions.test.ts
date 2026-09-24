import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import { GitHubContributions, validateContributionChanges, type ContributionCaller } from "../src/common/githubContributions.js";
import { GitHubContributionApi, GitHubRequestError, type ContributionApi, type GitHubRole } from "../src/common/githubContributionApi.js";
import { githubContributionsEnabled, loadGitHubContributionConfiguration, type ContributionRepository, type GitHubContributionConfiguration } from "../src/common/githubContributionConfig.js";
import { GitHubContributionRun, GitHubContributionSessions } from "../src/common/githubContributionToolBridge.js";
import { resolveSessionContext } from "../src/common/sessionContext.js";
import { providerChildEnvironment, secureSystemPrompt } from "../src/common/providerSecurity.js";
import { codexClientOptions } from "../src/providers/codex.js";
import { openCodeChildEnvironment } from "../src/providers/opencode.js";
import { createCopilotPermissionHandler } from "../src/providers/copilot.js";

const digest = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
const repository: ContributionRepository = { upstream: "Rubiss-Projects/ai-assistant", upstreamId: 1, fork: "Rubiss/contributions", forkId: 2 };
type TreeEntry = { path: string; sha: string; size: number; type: string; mode: string };
type MockPull = { number: number; html_url: string; state: string; draft: boolean; merged: boolean; user: { login: string }; head: { ref: string; sha: string; repo: { id: number } }; base: { ref: string; repo: { id: number } } };

class RepositoryApi implements ContributionApi {
  calls: { role: GitHubRole; method: string; suffix: string; body: unknown }[] = [];
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly commits = new Map<string, { tree: string; parent?: string }>();
  readonly refs = new Map<string, string>();
  readonly pulls: MockPull[] = [];
  readonly base: string;
  invalidFork = false;
  failAfterRef = false;
  failAfterPull = false;
  beforeMutation?: () => void;
  constructor() {
    const tree = this.addTree({ "README.md": "Hello\n", "src/main.ts": "export const value = 1;\n" });
    this.base = digest("base"); this.commits.set(this.base, { tree });
  }
  addTree(files: Record<string, string>): string {
    const entries = Object.entries(files).sort().map(([path, content]) => {
      const sha = digest(content); this.blobs.set(sha, content);
      return { path, sha, size: Buffer.byteLength(content), type: "blob", mode: "100644" };
    });
    const tree = digest(entries); this.trees.set(tree, entries); return tree;
  }
  async request<T>(role: GitHubRole, _repository: ContributionRepository, method: string, suffix: string, raw: unknown, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    this.calls.push({ role, method, suffix, body: raw });
    if (method !== "GET") this.beforeMutation?.();
    const body = raw as Record<string, unknown> | undefined;
    let result: unknown;
    if (!suffix) result = role === "publisher"
      ? { id: 1, full_name: repository.upstream, private: false, archived: false, default_branch: "main" }
      : { id: 2, full_name: repository.fork, private: false, archived: false, fork: true, parent: { id: this.invalidFork ? 999 : 1 } };
    else if (suffix === "/git/ref/heads/main") result = { object: { sha: this.base } };
    else if (suffix.startsWith("/git/ref/heads/")) {
      const head = this.refs.get(suffix.slice("/git/ref/heads/".length));
      if (!head) throw new GitHubRequestError(404);
      result = { object: { sha: head } };
    } else if (suffix.startsWith("/git/trees/") && method === "GET") {
      const commit = suffix.slice("/git/trees/".length).split("?")[0];
      const tree = this.commits.get(commit)!.tree;
      result = { sha: tree, tree: this.trees.get(tree), truncated: false };
    } else if (suffix.startsWith("/git/blobs/")) {
      const content = this.blobs.get(suffix.slice("/git/blobs/".length))!;
      result = { content: Buffer.from(content).toString("base64"), encoding: "base64", size: Buffer.byteLength(content) };
    } else if (suffix === "/git/trees") {
      assert.equal(role, "writer");
      const files = Object.fromEntries(this.trees.get(body!.base_tree as string)!.map(entry => [entry.path, this.blobs.get(entry.sha)!]));
      for (const change of body!.tree as { path: string; content?: string; sha?: null }[]) {
        if (change.sha === null) delete files[change.path]; else files[change.path] = change.content!;
      }
      result = { sha: this.addTree(files) };
    } else if (suffix === "/git/commits") {
      assert.equal(role, "writer");
      assert.equal(body!.author, undefined); assert.equal(body!.committer, undefined);
      const id = digest(body); this.commits.set(id, { tree: body!.tree as string, parent: (body!.parents as string[])[0] }); result = { sha: id };
    } else if (suffix.startsWith("/git/refs")) {
      assert.equal(role, "writer");
      const branch = method === "POST" ? (body!.ref as string).slice("refs/heads/".length) : suffix.slice("/git/refs/heads/".length);
      if (method === "PATCH") { assert.equal(body!.force, false); assert.equal(this.commits.get(body!.sha as string)!.parent, this.refs.get(branch)); }
      else assert.equal(this.refs.has(branch), false);
      this.refs.set(branch, body!.sha as string); result = { object: { sha: body!.sha } };
      if (this.failAfterRef) { this.failAfterRef = false; throw new Error("Simulated lost reference response"); }
    } else if (suffix.startsWith("/pulls?") && method === "GET") {
      const head = new URL(`https://api.github.com${suffix}`).searchParams.get("head")!.split(":")[1];
      result = this.pulls.filter(pull => pull.head.ref === head);
    } else if (suffix === "/pulls" && method === "POST") {
      assert.equal(role, "publisher"); assert.equal(body!.draft, true); assert.equal(body!.maintainer_can_modify, false);
      const branch = (body!.head as string).split(":")[1];
      const pull: MockPull = { number: this.pulls.length + 1, html_url: "https://github.com/example/pull/1", state: "open", draft: true, merged: false,
        user: { login: "publisher[bot]" }, head: { ref: branch, sha: this.refs.get(branch)!, repo: { id: 2 } }, base: { ref: "main", repo: { id: 1 } } };
      this.pulls.push(pull); result = pull;
      if (this.failAfterPull) { this.failAfterPull = false; throw new Error("Simulated lost PR response"); }
    } else if (/^\/pulls\/\d+$/.test(suffix)) {
      assert.equal(role, "publisher"); const pull = this.pulls[Number(suffix.split("/").at(-1)) - 1];
      pull.head.sha = this.refs.get(pull.head.ref)!; result = pull;
    } else throw new Error(`Unexpected API operation ${method} ${suffix}`);
    return structuredClone(result) as T;
  }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "github-contributions-"));
  const names = ["AI_ASSISTANT_SECURITY_MODE", "AI_ASSISTANT_WORKSPACE_ROOT", "AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS", "GITHUB_CONTRIBUTIONS_ACCESS"] as const;
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
  Object.assign(process.env, { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: join(directory, "workspace"), AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", GITHUB_CONTRIBUTIONS_ACCESS: "chat" });
  mkdirSync(process.env.AI_ASSISTANT_WORKSPACE_ROOT!);
  const config: GitHubContributionConfiguration = { publisher: { appId: 10, installationId: 11, keyFile: join(directory, "publisher.pem") }, writer: { appId: 20, installationId: 21, keyFile: join(directory, "writer.pem") }, publisherBotLogin: "publisher[bot]", repositories: [repository], stateFile: join(directory, "state.json") };
  const api = new RepositoryApi();
  const service = new GitHubContributions(config, api);
  const access = createAccessPolicy({ DISCORD_ALLOWED_USERS: "123", DISCORD_ADMIN_USERS: "456", GITHUB_CONTRIBUTIONS_ACCESS: "chat" });
  const caller: ContributionCaller = { session: "thread:one", requester: { userId: "123", guildId: "789" }, access, signal: new AbortController().signal };
  return { directory, config, api, service, caller };
}

test("a contribution keeps identity, unchanged files, and session ownership through draft PR revisions", async t => {
  const { service, api, caller } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  assert.equal(api.calls.some(call => call.method !== "GET"), false);
  assert.match((await service.read(caller, started.contribution_id, "src/main.ts")).content, /value = 1/);
  const published = await service.publish(caller, started.contribution_id, started.head_sha, "feat: contribute a change", "Tested locally.", [{ path: "src/main.ts", content: "export const value = 2;\n" }]);
  assert.equal(published.draft, true); assert.equal(api.pulls.length, 1);
  assert.equal((await service.read(caller, started.contribution_id, "README.md")).content, "Hello\n");
  await service.publish(caller, started.contribution_id, published.head_sha, "feat: revise contribution", "Reviewed.", [{ path: "README.md", content: null }]);
  assert.equal(api.pulls.length, 1);
  assert.equal(api.calls.filter(call => call.method !== "GET" && call.role === "publisher").every(call => /^\/pulls(?:\/\d+)?$/.test(call.suffix)), true);
  await assert.rejects(service.read({ ...caller, session: "thread:two" }, started.contribution_id, "src/main.ts"), /another Discord/);
  await assert.rejects(service.status({ ...caller, requester: { ...caller.requester, userId: "456" } }, started.contribution_id), /another Discord/);
  await assert.rejects(service.status({ ...caller, requester: { ...caller.requester, guildId: "different" } }, started.contribution_id), /another Discord/);
});

test("publishing fails closed for invalid changes, identity changes, stale heads, and closed PRs", async t => {
  const { service, api, caller } = fixture(t);
  await assert.rejects(service.begin(caller, "other/repo"), /enabled contribution/);
  const started = await service.begin(caller, repository.upstream);
  const changes = [{ path: "src/main.ts", content: "updated" }];
  const publish = (head = started.head_sha) => service.publish(caller, started.contribution_id, head, "feat: change", "", changes);
  api.invalidFork = true; await assert.rejects(publish(), /fork relationship/); api.invalidFork = false;
  await assert.rejects(publish(digest("stale")), /head changed/);
  assert.equal(api.calls.some(call => call.method !== "GET"), false);
  const published = await publish();
  api.refs.set(api.pulls[0].head.ref, digest("external edit"));
  await assert.rejects(publish(published.head_sha), /outside this session/);
  api.refs.set(api.pulls[0].head.ref, published.head_sha);
  api.pulls[0].user.login = "someone-else[bot]"; await assert.rejects(publish(published.head_sha), /identity changed/);
  api.pulls[0].user.login = "publisher[bot]"; api.pulls[0].state = "closed";
  await assert.rejects(publish(published.head_sha), /closed/);
  assert.equal((await service.status(caller, started.contribution_id)).closed, true);
  for (const path of ["../x", "/x", "src\\x", ".github/workflows/test.yml", ".GitHub/actions/x", ".env.secret", "keys/app.pem", ".git/config"]) assert.throws(() => validateContributionChanges([{ path, content: "x" }]));
  assert.throws(() => validateContributionChanges([{ path: "x", content: "-----BEGIN RSA PRIVATE KEY-----" }]), /credentials/);
  assert.throws(() => validateContributionChanges([{ path: "x", content: "x".repeat(200001) }]), /size/);
  assert.throws(() => validateContributionChanges([{ path: "x", content: "x" }, { path: "X", content: "y" }]), /Duplicate/);
});

test("lost remote responses recover after restart without duplicate PRs or force pushes", async t => {
  const { service, config, api, caller } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  const changes = [{ path: "README.md", content: "Changed\n" }];
  api.failAfterRef = true;
  await assert.rejects(service.publish(caller, started.contribution_id, started.head_sha, "docs: test", "", changes), /lost reference/);
  const restarted = new GitHubContributions(config, api);
  await assert.rejects(restarted.publish(caller, started.contribution_id, started.head_sha, "docs: test", "", changes), /head changed/);
  const status = await restarted.status(caller, started.contribution_id);
  assert.equal(status.pending_publish, false);
  api.failAfterPull = true;
  await assert.rejects(restarted.publish(caller, started.contribution_id, status.head_sha, "docs: test", "", changes), /lost PR/);
  const recovered = new GitHubContributions(config, api);
  const result = await recovered.publish(caller, started.contribution_id, status.head_sha, "docs: test", "", changes);
  assert.match(result.pull_request_url!, /\/pull\/1$/);
  assert.equal(api.pulls.length, 1);
  assert.equal(api.calls.filter(call => call.method === "POST" && call.suffix === "/git/commits").length, 1);
  assert.doesNotMatch(readFileSync(config.stateFile, "utf8"), /PRIVATE KEY|token/);
});

test("authorization and cancellation are rechecked before each network mutation", async t => {
  const { service, api, caller } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  const controller = new AbortController();
  api.beforeMutation = () => controller.abort();
  await assert.rejects(service.publish({ ...caller, signal: controller.signal }, started.contribution_id, started.head_sha, "feat: abort", "", [{ path: "README.md", content: "x" }]));
  assert.equal(api.calls.filter(call => call.method !== "GET").length, 1);
  assert.equal(api.refs.size, 0);
  const denied = { ...caller, requester: { userId: "999" } };
  await assert.rejects(service.begin(denied, repository.upstream), /access/);
  const run = new GitHubContributionRun(caller.session, { rulesetContext: { requester: caller.requester, access: caller.access } }, () => service);
  await assert.rejects(run.call("github_contribution_begin", { run_id: "other", repository: repository.upstream }), /another session/);
  await run.cancel();
  await assert.rejects(run.call("github_contribution_begin", { run_id: run.id, repository: repository.upstream }));
  for (const contextProfile of ["scheduled", "ephemeral", "one-shot"] as const) {
    const restricted = new GitHubContributionRun(caller.session, { contextProfile, rulesetContext: { requester: caller.requester, access: caller.access } }, () => service);
    await assert.rejects(restricted.call("github_contribution_begin", { run_id: restricted.id, repository: repository.upstream }), /unavailable/);
  }
});

test("chat and explicit grants are configurable without granting legacy open-admin access", t => {
  const { directory } = fixture(t);
  const strict = createAccessPolicy({ GITHUB_CONTRIBUTIONS_ACCESS: "granted" });
  assert.equal(strict.can({ userId: "123" }, "github.contribute"), false);
  const chat = createAccessPolicy({ DISCORD_ALLOWED_USERS: "123", DISCORD_ADMIN_USERS: "456", GITHUB_CONTRIBUTIONS_ACCESS: "chat" });
  assert.equal(chat.can({ userId: "123" }, "github.contribute"), true);
  assert.equal(chat.can({ userId: "999" }, "github.contribute"), false);
  assert.throws(() => createAccessPolicy({ GITHUB_CONTRIBUTIONS_ACCESS: "all" }), /must be/);
  const rights = join(directory, "rights.json");
  writeFileSync(rights, JSON.stringify({ grants: [{ roleId: "10", guildId: "20", roles: ["contributor"] }] }));
  const granted = createAccessPolicy({ DISCORD_RIGHTS_FILE: rights, GITHUB_CONTRIBUTIONS_ACCESS: "granted" });
  assert.equal(granted.can({ userId: "123", guildId: "20", roleIds: ["10"] }, "github.contribute"), true);
  assert.equal(granted.can({ userId: "123", guildId: "21", roleIds: ["10"] }, "github.contribute"), false);
});

test("configuration keeps keys and state outside provider workspaces and limits upstream selection", t => {
  const { config, directory } = fixture(t);
  const file = join(directory, "setup.json");
  writeFileSync(config.publisher.keyFile, "test fixture"); writeFileSync(config.writer.keyFile, "test fixture");
  const raw = { publisher: { app_id: 10, installation_id: 11, private_key_file: "publisher.pem", bot_login: "publisher[bot]" },
    writer: { app_id: 20, installation_id: 21, private_key_file: "writer.pem" },
    repositories: [{ upstream: repository.upstream, upstream_id: 1, fork: repository.fork, fork_id: 2 }] };
  writeFileSync(file, JSON.stringify(raw));
  const env = { ...process.env, GITHUB_CONTRIBUTIONS_CONFIG_FILE: file, GITHUB_CONTRIBUTIONS_STATE_FILE: config.stateFile };
  assert.equal(loadGitHubContributionConfiguration(env).publisher.keyFile, config.publisher.keyFile);
  assert.throws(() => loadGitHubContributionConfiguration({ ...env, GITHUB_CONTRIBUTIONS_STATE_FILE: join(process.env.AI_ASSISTANT_WORKSPACE_ROOT!, "state.json") }), /outside/);
  raw.publisher.private_key_file = "workspace/key.pem";
  writeFileSync(join(directory, "workspace", "key.pem"), "test fixture"); writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => loadGitHubContributionConfiguration(env), /outside/);
  raw.publisher.private_key_file = "publisher.pem"; raw.repositories[0].upstream = "other/repo"; writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => loadGitHubContributionConfiguration(env), /Unsupported/);
});

test("simultaneous revisions cannot overwrite an accepted publish", async t => {
  const { service, api, caller } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  const results = await Promise.allSettled(["first", "second"].map(content => service.publish(caller, started.contribution_id, started.head_sha, "docs: change", "", [{ path: "README.md", content }])));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(api.pulls.length, 1);
  assert.equal((await service.read(caller, started.contribution_id, "README.md")).content, "first");
});

test("provider policies expose only the contribution bridge and refresh its capability fingerprint", async t => {
  const { directory } = fixture(t);
  const bridge = { command: "node", args: ["githubContributionMcp.js"], env: { AI_GITHUB_BRIDGE_TOKEN: "session-only" } };
  const context = resolveSessionContext();
  assert.equal(context.githubContributionsEnabled, true);
  assert.equal(resolveSessionContext({ profile: "scheduled" }).githubContributionsEnabled, false);
  assert.equal(resolveSessionContext({ profile: "ephemeral" }).githubContributionsEnabled, false);
  assert.equal(resolveSessionContext({ profile: "one-shot" }).githubContributionsEnabled, false);
  assert.match(secureSystemPrompt(), /host-owned github_contributions/);
  const codex = codexClientOptions(directory, undefined, undefined, context.systemPrompt, bridge);
  assert.match(JSON.stringify(codex.configOverrides), /github_contributions/);
  assert.match(JSON.stringify(codex.configOverrides), /network=\{enabled=false\}/);
  const openCode = openCodeChildEnvironment(process.env, undefined, undefined, context.systemPrompt, undefined, bridge);
  assert.match(openCode.OPENCODE_CONFIG_CONTENT, /github_contributions/);
  assert.equal(JSON.parse(openCode.OPENCODE_CONFIG_CONTENT).permission.bash, "deny");
  const decide = createCopilotPermissionHandler(directory);
  assert.equal((await decide({ kind: "mcp", serverName: "github_contributions", toolName: "github_contribution_publish", toolTitle: "Publish", readOnly: false }, { sessionId: "test" })).kind, "approve-once");
  assert.equal((await decide({ kind: "mcp", serverName: "github", toolName: "create_pull_request", toolTitle: "Publish", readOnly: false }, { sessionId: "test" })).kind, "reject");
  assert.equal(providerChildEnvironment("codex", { ...process.env, GITHUB_CONTRIBUTIONS_CONFIG_FILE: "/host/secret.json" }).GITHUB_CONTRIBUTIONS_CONFIG_FILE, undefined);
  process.env.AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS = "false";
  assert.equal(resolveSessionContext().githubContributionsEnabled, false);
  assert.notEqual(resolveSessionContext().applied.capabilities, context.applied.capabilities);
  assert.throws(() => githubContributionsEnabled({ AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_SECURITY_MODE: "unrestricted" }), /shared/);
});

test("bridge credentials are session-specific and expired runs reject requests", async t => {
  const { service, caller } = fixture(t);
  const sessions = new GitHubContributionSessions(() => service); t.after(() => sessions.shutdown());
  const one = await sessions.config("one"); const two = await sessions.config("two");
  assert.notEqual(one.env.AI_GITHUB_BRIDGE_TOKEN, two.env.AI_GITHUB_BRIDGE_TOKEN);
  const rejected = await fetch(one.env.AI_GITHUB_BRIDGE_URL, { method: "POST", headers: { authorization: `Bearer ${two.env.AI_GITHUB_BRIDGE_TOKEN}` } });
  assert.equal(rejected.status, 403);
  const expired = await fetch(one.env.AI_GITHUB_BRIDGE_URL, { method: "POST", headers: { authorization: `Bearer ${one.env.AI_GITHUB_BRIDGE_TOKEN}` }, body: JSON.stringify({ name: "github_contribution_status", arguments: { run_id: "expired" } }) });
  assert.match(await expired.text(), /inactive/);
  await sessions.run("one", { rulesetContext: { requester: caller.requester, access: caller.access } }, true, async run => {
    const response = await fetch(one.env.AI_GITHUB_BRIDGE_URL, { method: "POST", headers: { authorization: `Bearer ${one.env.AI_GITHUB_BRIDGE_TOKEN}` }, body: JSON.stringify({ name: "github_contribution_begin", arguments: { run_id: run!.id, repository: repository.upstream } }) });
    const result = await response.json() as { content: { text: string }[]; isError?: boolean };
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).repository, repository.upstream);
  });
});

test("App tokens are scoped to one repository and errors do not expose response secrets", async t => {
  const { config } = fixture(t);
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  writeFileSync(config.publisher.keyFile, key); writeFileSync(config.writer.keyFile, key);
  const calls: { url: string; options?: RequestInit }[] = [];
  const api = new GitHubContributionApi(config, async (input, options) => {
    const url = String(input); calls.push({ url, options });
    assert.equal(options?.redirect, "error");
    if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-secret", expires_at: new Date(Date.now() + 3600000).toISOString(), repositories: [{ id: 1 }], permissions: { metadata: "read", contents: "read", pull_requests: "write" } });
    return new Response(JSON.stringify({ message: "SECRET_RESPONSE_TOKEN" }), { status: 403 });
  });
  await assert.rejects(api.request("publisher", repository, "POST", "/pulls", {}, new AbortController().signal), error => error instanceof GitHubRequestError && error.status === 403 && !error.message.includes("SECRET_RESPONSE_TOKEN"));
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { repository_ids: [1], permissions: { contents: "read", pull_requests: "write" } });
  assert.equal(calls[1].url, "https://api.github.com/repos/Rubiss-Projects/ai-assistant/pulls");
});
