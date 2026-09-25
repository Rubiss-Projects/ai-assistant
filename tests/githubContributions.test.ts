import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import { GitHubContributions, validateContributionChanges, type ContributionCaller } from "../src/common/githubContributions.js";
import { GitHubContributionApi, GitHubRequestError, type ContributionApi, type GitHubRole } from "../src/common/githubContributionApi.js";
import { githubContributionsEnabled, loadGitHubContributionConfiguration, type ContributionRepository, type GitHubContributionConfiguration } from "../src/common/githubContributionConfig.js";
import { GitHubContributionRun, GitHubContributionSessions } from "../src/common/githubContributionToolBridge.js";
import { GITHUB_CONTRIBUTION_CALL_LIMITS } from "../src/common/githubContributionToolDefinitions.js";
import { REVIEW_THREADS_QUERY, REVIEW_THREAD_QUERY, REPLY_REVIEW_THREAD, RESOLVE_REVIEW_THREAD, type ReviewThread } from "../src/common/githubContributionReviews.js";
import { resolveSessionContext } from "../src/common/sessionContext.js";
import { providerChildEnvironment, secureSystemPrompt } from "../src/common/providerSecurity.js";
import { codexClientOptions } from "../src/providers/codex.js";
import { openCodeChildEnvironment } from "../src/providers/opencode.js";
import { createCopilotPermissionHandler } from "../src/providers/copilot.js";
import { writeReviewState, type ReviewTransport } from "../src/common/codexReviewWorker.js";

const digest = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
const repository: ContributionRepository = { upstream: "Rubiss-Projects/ai-assistant", upstreamId: 1, fork: "Rubiss/contributions", forkId: 2 };
type TreeEntry = { path: string; sha: string; size: number; type: string; mode: string };
type MockPull = { number: number; html_url: string; state: string; draft: boolean; merged: boolean; user: { login: string }; head: { ref: string; sha: string; repo: { id: number } }; base: { ref: string; sha: string; repo: { id: number } }; changed_files: number };

class RepositoryApi implements ContributionApi {
  calls: { role: GitHubRole; method: string; suffix: string; body: unknown }[] = [];
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly commits = new Map<string, { tree: string; parent?: string }>();
  readonly refs = new Map<string, string>();
  readonly pulls: MockPull[] = [];
  readonly reviewThreads: ReviewThread[] = [];
  failAfterReply = false;
  readonly base: string;
  invalidFork = false;
  failBeforeRef = false;
  failAfterRef = false;
  failAfterPull = false;
  beforeMutation?: () => void;
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
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
  async graphql<T>(_repository: ContributionRepository, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    await this.beforeRequest?.(signal);
    signal.throwIfAborted();
    const mutation = query.startsWith("mutation");
    this.calls.push({ role: "publisher", method: mutation ? "POST" : "GET", suffix: "/graphql", body: { query, variables } });
    if (mutation) this.beforeMutation?.();
    for (const thread of this.reviewThreads) {
      const pull = this.pulls.find(item => item.number === thread.pullRequest.number);
      if (pull) thread.pullRequest.headRefOid = this.refs.get(pull.head.ref)!;
    }
    let result: unknown;
    if (query === REVIEW_THREADS_QUERY) {
      const offset = Number(variables.after ?? 0);
      result = { repository: { pullRequest: { reviewThreads: { nodes: this.reviewThreads.slice(offset, offset + 25),
        pageInfo: { hasNextPage: offset + 25 < this.reviewThreads.length, endCursor: String(offset + 25) } } } } };
    } else if (query === REVIEW_THREAD_QUERY) {
      result = { node: this.reviewThreads.find(thread => thread.id === variables.id) ?? null };
    } else if (query === REPLY_REVIEW_THREAD) {
      const thread = this.reviewThreads.find(item => item.id === variables.thread)!;
      const comment = { id: `comment-${thread.comments.nodes.length}`, url: "https://github.com/example/pull/1#discussion_r2",
        author: { __typename: "Bot", login: "publisher" }, body: String(variables.body), updatedAt: new Date().toISOString(),
        commit: { oid: thread.pullRequest.headRefOid }, pullRequestReview: { state: "COMMENTED" } };
      thread.comments.nodes.push(comment);
      if (this.failAfterReply) { this.failAfterReply = false; throw new Error("Lost reply response"); }
      result = { addPullRequestReviewThreadReply: { comment } };
    } else if (query === RESOLVE_REVIEW_THREAD) {
      const thread = this.reviewThreads.find(item => item.id === variables.thread)!;
      thread.isResolved = true;
      result = { resolveReviewThread: { thread } };
    } else throw new Error("Unexpected GraphQL document");
    return structuredClone(result) as T;
  }
  async request<T>(role: GitHubRole, _repository: ContributionRepository, method: string, suffix: string, raw: unknown, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    await this.beforeRequest?.(signal);
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
      if (this.failBeforeRef) { this.failBeforeRef = false; throw new Error("Simulated failed reference request"); }
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
        user: { login: "publisher[bot]" }, head: { ref: branch, sha: this.refs.get(branch)!, repo: { id: 2 } }, base: { ref: "main", sha: this.base, repo: { id: 1 } }, changed_files: 1 };
      this.pulls.push(pull); result = pull;
      if (this.failAfterPull) { this.failAfterPull = false; throw new Error("Simulated lost PR response"); }
    } else if (/^\/pulls\/\d+\/reviews\?/.test(suffix) && method === "GET") result = [];
    else if (/^\/pulls\/\d+$/.test(suffix)) {
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

test("background reviews refresh Discord roles immediately before publication", async t => {
  const { service, config, api, caller, directory } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  const published = await service.publish(caller, started.contribution_id, started.head_sha, "docs: test", "", [{ path: "README.md", content: "Changed\n" }]);
  const env = { AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true", GITHUB_CONTRIBUTIONS_ACCESS: "granted", DISCORD_ALLOWED_USERS: "456", DISCORD_ADMIN_USERS: "456", DISCORD_RIGHTS_FILE: join(directory, "rights.json") };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  writeFileSync(env.DISCORD_RIGHTS_FILE, JSON.stringify({ grants: [{ roleId: "999", guildId: "789", roles: ["contributor"] }] }));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const receipt = { id: randomUUID(), repository: repository.upstream, pull: 1, head: published.head_sha, base: api.base, digest: "snapshot" };
  const state = `${config.stateFile}.reviews.json`;
  writeReviewState(state, [{ ...receipt, contribution: started.contribution_id, session: caller.session, requester: { ...caller.requester, roleIds: ["999"] },
    createdAt: Date.now(), state: "submitted", failures: 0, nextPoll: 0,
    changes: [{ path: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-Hello\n+Changed", additions: 1, deletions: 1 }] }]);
  const transport: ReviewTransport = { get: async () => ({ ...receipt, state: "completed", result: { summary: "No findings.", findings: [] } }), submit: async () => { throw new Error("Already submitted"); } };
  const resumed = new GitHubContributions(config, api, transport);
  let refreshes = 0;
  t.mock.timers.enable({ apis: ["setInterval"] });
  resumed.startReviews(async (userId, guildId) => ({ userId, guildId, roleIds: ++refreshes === 1 ? ["999"] : [] }));
  t.after(() => resumed.stopReviews());
  const mutations = api.calls.filter(call => call.method !== "GET").length;
  t.mock.timers.tick(2000);
  for (let i = 0; i < 100 && refreshes < 2; i++) await delay(5);
  await resumed.stopReviews();
  assert.equal(refreshes, 2);
  assert.equal(api.calls.filter(call => call.method !== "GET").length, mutations);
  assert.notEqual(JSON.parse(readFileSync(state, "utf8"))[0].state, "completed");
});

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

for (const resume of ["status", "begin"] as const) test(`${resume} recovers lost remote responses after restart without duplicate PRs or force pushes`, async t => {
  const { service, config, api, caller } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  const changes = [{ path: "README.md", content: "Changed\n" }];
  api.failAfterRef = true;
  await assert.rejects(service.publish(caller, started.contribution_id, started.head_sha, "docs: test", "", changes), /lost reference/);
  const restarted = new GitHubContributions(config, api);
  const resumed = resume === "status" ? await restarted.status(caller, started.contribution_id) : await restarted.begin(caller, repository.upstream);
  assert.equal(resumed.head_sha, [...api.refs.values()][0]);
  assert.notEqual(resumed.head_sha, started.head_sha);
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

test("status finishes a failed branch write but never resumes a closed PR", async t => {
  const { service, api, caller } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  const changes = [{ path: "README.md", content: "Changed\n" }];
  api.failBeforeRef = true;
  await assert.rejects(service.publish(caller, started.contribution_id, started.head_sha, "docs: test", "", changes), /failed reference/);
  const status = await service.status(caller, started.contribution_id);
  assert.equal(status.pending_publish, false);
  assert.equal(status.head_sha, [...api.refs.values()][0]);
  const published = await service.publish(caller, started.contribution_id, status.head_sha, "docs: test", "", changes);
  api.failBeforeRef = true;
  await assert.rejects(service.publish(caller, started.contribution_id, published.head_sha, "docs: revision", "", [{ path: "README.md", content: "Revised" }]), /failed reference/);
  api.pulls[0].state = "closed";
  const mutations = api.calls.filter(call => call.method !== "GET").length;
  assert.equal((await service.status(caller, started.contribution_id)).closed, true);
  assert.equal(api.calls.filter(call => call.method !== "GET").length, mutations);
  assert.equal([...api.refs.values()][0], published.head_sha);
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

test("parallel reads cannot exhaust publishing or recovery and budgets reset next turn", async t => {
  const { service, api, caller } = fixture(t);
  const options = { rulesetContext: { requester: caller.requester, access: caller.access } };
  const run = new GitHubContributionRun(caller.session, options, () => service);
  t.after(() => run.cancel());
  const started = await service.begin(caller, repository.upstream);
  const args = { run_id: run.id, contribution_id: started.contribution_id };
  assert.deepEqual(await run.call("github_contribution_begin", { run_id: run.id, repository: repository.upstream }), {
    ...started, remaining_calls: { ...GITHUB_CONTRIBUTION_CALL_LIMITS, github_contribution_begin: 9 },
  });
  const reads = await Promise.allSettled(Array.from({ length: 201 }, () => run.call("github_contribution_read", { ...args, path: "README.md" })));
  assert.equal(reads.filter(result => result.status === "fulfilled").length, 200);
  assert.equal(reads.filter(result => result.status === "rejected").length, 1);
  const calls = api.calls.length;
  await assert.rejects(run.call("github_contribution_read", { ...args, path: "README.md" }), /read limit reached.*Other tool budgets are independent/);
  assert.equal(api.calls.length, calls, "exhausted reads must not reach GitHub");
  await run.call("github_contribution_status", args);
  for (let index = 0; index < GITHUB_CONTRIBUTION_CALL_LIMITS.github_contribution_publish; index++) {
    const current = await service.status(caller, started.contribution_id);
    await run.call("github_contribution_publish", { ...args, expected_head_sha: current.head_sha, title: "docs: update", body: "Tested.", changes: [{ path: "README.md", content: `Revision ${index}` }] });
  }
  assert.equal(api.pulls.length, 1, "publishing and revising still work after exhausting reads");
  const current = await service.status(caller, started.contribution_id);
  await assert.rejects(run.call("github_contribution_publish", { ...args, expected_head_sha: current.head_sha, title: "docs: update", body: "", changes: [{ path: "README.md", content: "Fourth" }] }), /publish limit reached/);
  assert.deepEqual(await run.call("github_contribution_status", args), {
    ...current, remaining_calls: { ...GITHUB_CONTRIBUTION_CALL_LIMITS, github_contribution_begin: 9, github_contribution_read: 0, github_contribution_status: 8, github_contribution_publish: 0 },
  });
  const next = new GitHubContributionRun(caller.session, options, () => service);
  t.after(() => next.cancel());
  assert.deepEqual(await next.call("github_contribution_read", { ...args, run_id: next.id, path: "README.md" }), {
    ...await service.read(caller, started.contribution_id, "README.md"),
    remaining_calls: { ...GITHUB_CONTRIBUTION_CALL_LIMITS, github_contribution_read: 199 },
  });
});

test("failed operations consume only their own bounded budget", async t => {
  const { service, api, caller } = fixture(t);
  const run = new GitHubContributionRun(caller.session, { rulesetContext: { requester: caller.requester, access: caller.access } }, () => service);
  t.after(() => run.cancel());
  const started = await service.begin(caller, repository.upstream);
  for (let index = 0; index < 10; index++) {
    await assert.rejects(run.call("github_contribution_begin", { run_id: run.id, repository: "other/repo" }), /enabled contribution/);
    await assert.rejects(run.call("github_contribution_status", { run_id: run.id, contribution_id: "missing" }));
  }
  const calls = api.calls.length;
  await assert.rejects(run.call("github_contribution_begin", { run_id: run.id, repository: repository.upstream }), /begin limit reached/);
  await assert.rejects(run.call("github_contribution_status", { run_id: run.id, contribution_id: started.contribution_id }), /status limit reached/);
  assert.equal(api.calls.length, calls);
  await run.call("github_contribution_publish", { run_id: run.id, contribution_id: started.contribution_id, expected_head_sha: started.head_sha, title: "docs: update", body: "", changes: [{ path: "README.md", content: "Updated" }] });
  assert.equal(api.pulls.length, 1);
});

test("abandoned inspections do not consume the quota, while publishing enforces it", async t => {
  const { service, api, caller } = fixture(t);
  const starts = [];
  for (let index = 0; index < 6; index++) {
    const requester = { ...caller, session: `thread:${index}` };
    starts.push({ requester, contribution: await service.begin(requester, repository.upstream) });
  }
  const changes = [{ path: "README.md", content: "Updated" }];
  for (const { requester, contribution } of starts.slice(0, 5)) {
    await service.publish(requester, contribution.contribution_id, contribution.head_sha, "docs: update", "", changes);
  }
  const last = starts[5];
  const publish = () => service.publish(last.requester, last.contribution.contribution_id, last.contribution.head_sha, "docs: update", "", changes);
  const mutations = api.calls.filter(call => call.method !== "GET").length;
  await assert.rejects(publish(), /Five unfinished published/);
  assert.equal(api.calls.filter(call => call.method !== "GET").length, mutations);
  api.pulls[0].state = "closed";
  // The original thread is unavailable: the new conversation must reclaim the closed slot itself.
  await publish();
  assert.equal(api.pulls.length, 6);
});

test("one tool deadline cancels sequential host requests before the transport times out", async t => {
  const { service, api, caller } = fixture(t);
  const started = await service.begin(caller, repository.upstream);
  const signals: AbortSignal[] = [];
  api.beforeRequest = async signal => { signals.push(signal); await delay(15, undefined, { signal }); };
  const run = new GitHubContributionRun(caller.session, { rulesetContext: { requester: caller.requester, access: caller.access } }, () => service, 45);
  await assert.rejects(run.call("github_contribution_publish", { run_id: run.id, contribution_id: started.contribution_id, expected_head_sha: started.head_sha,
    title: "docs: change", body: "", changes: [{ path: "README.md", content: "Updated" }] }), /aborted|timed out/);
  assert.ok(signals.length > 0);
  assert.equal(new Set(signals).size, 1, "all requests share the tool's overall deadline");
  assert.equal(signals[0].aborted, true);
  const calls = api.calls.length;
  await delay(30);
  assert.equal(api.calls.length, calls, "no host operation continues after the deadline");
  assert.equal(api.pulls.length, 0);
  await run.cancel();
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
    const started = JSON.parse(result.content[0].text) as { repository: string; contribution_id: string; head_sha: string };
    assert.equal(started.repository, repository.upstream);
    const content = "\u0001".repeat(200_000);
    const body = JSON.stringify({ name: "github_contribution_publish", arguments: { run_id: run!.id, contribution_id: started.contribution_id, expected_head_sha: started.head_sha,
      title: "test: escaped text", body: "", changes: Array.from({ length: 5 }, (_, index) => ({ path: `escaped-${index}.txt`, content })) } });
    assert.ok(Buffer.byteLength(body) > 6_000_000, "exercise worst-case JSON expansion of one MB of permitted text");
    const published = await fetch(one.env.AI_GITHUB_BRIDGE_URL, { method: "POST", headers: { authorization: `Bearer ${one.env.AI_GITHUB_BRIDGE_TOKEN}` }, body });
    assert.equal(published.status, 200);
    const publishResult = await published.json() as { isError?: boolean; content: { text: string }[] };
    assert.equal(publishResult.isError, undefined);
    assert.equal(JSON.parse(publishResult.content[0].text).draft, true);
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

async function reviewFixture(t: TestContext) {
  const context = fixture(t);
  const { service, caller, api } = context;
  const started = await service.begin(caller, repository.upstream);
  const published = await service.publish(caller, started.contribution_id, started.head_sha, "feat: initial change", "", [{ path: "README.md", content: "Initial" }]);
  const thread: ReviewThread = { id: "PRRT_one", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "README.md", line: 1,
    pullRequest: { number: 1, repository: { databaseId: repository.upstreamId }, headRefOid: published.head_sha, state: "OPEN" },
    comments: { nodes: [{ id: "PRRC_one", author: { __typename: "Bot", login: "chatgpt-codex-connector" }, body: "Fix the missing case.", url: "https://github.com/example/pull/1#discussion_r1",
      updatedAt: "2026-09-24T00:00:00Z", commit: { oid: published.head_sha }, pullRequestReview: { state: "COMMENTED" } }], pageInfo: { hasNextPage: false } },
  };
  api.reviewThreads.push(thread);
  const fix = () => service.publish(caller, started.contribution_id, published.head_sha, "fix: address review", "Tested.", [{ path: "README.md", content: "Fixed" }]);
  return { ...context, published, thread, fix };
}

test("owned review tools publish replies and resolve only after a published fix and explanation", async t => {
  const { service, caller, api, published, fix, thread } = await reviewFixture(t);
  const id = published.contribution_id;
  let reviews = await service.reviews(caller, id);
  assert.equal(reviews.threads[0].comments[0].body, "Fix the missing case.");
  await assert.rejects(service.resolveReview(caller, id, thread.id, published.head_sha, reviews.threads[0].thread_version), /Publish the fix/);
  const fixed = await fix();
  reviews = await service.reviews(caller, id);
  await assert.rejects(service.resolveReview(caller, id, thread.id, fixed.head_sha, reviews.threads[0].thread_version), /reply explaining/);
  const run = new GitHubContributionRun(caller.session, { rulesetContext: { requester: caller.requester, access: caller.access } }, () => service);
  t.after(() => run.cancel());
  const args = { run_id: run.id, contribution_id: id, thread_id: thread.id, expected_head_sha: fixed.head_sha };
  await run.call("github_contribution_reply_review", { ...args, expected_thread_version: reviews.threads[0].thread_version, body: "Handled the missing case and tested it." });
  assert.match(thread.comments.nodes.at(-1)!.body, new RegExp(fixed.head_sha));
  await assert.rejects(service.resolveReview(caller, id, thread.id, fixed.head_sha, reviews.threads[0].thread_version), /thread changed/);
  const latest = await run.call("github_contribution_reviews", { run_id: run.id, contribution_id: id });
  assert.ok(latest);
  reviews = await service.reviews(caller, id);
  await run.call("github_contribution_resolve_review", { ...args, expected_thread_version: reviews.threads[0].thread_version });
  assert.equal(thread.isResolved, true);
  assert.equal((await service.resolveReview(caller, id, thread.id, fixed.head_sha, reviews.threads[0].thread_version)).already_resolved, true);
  assert.equal(api.calls.filter(call => call.suffix === "/graphql" && call.method === "POST").length, 2);
});

test("a human using the publisher App's login cannot satisfy the resolution prerequisite", async t => {
  const { service, caller, published, fix, thread } = await reviewFixture(t);
  const fixed = await fix();
  const id = published.contribution_id;
  let version = (await service.reviews(caller, id)).threads[0].thread_version;
  await service.replyReview(caller, id, thread.id, fixed.head_sha, version, "Fixed and tested.");
  thread.comments.nodes.at(-1)!.author!.__typename = "User";
  version = (await service.reviews(caller, id)).threads[0].thread_version;
  await assert.rejects(service.resolveReview(caller, id, thread.id, fixed.head_sha, version), /reply explaining/);
  assert.equal(thread.isResolved, false);
});

test("review mutations reject cross-session, cross-PR, stale feedback, and unsafe replies", async t => {
  const { service, caller, api, published, thread } = await reviewFixture(t);
  const id = published.contribution_id;
  const version = (await service.reviews(caller, id)).threads[0].thread_version;
  const reply = (body = "Tested fix", requestCaller = caller, head = published.head_sha) => service.replyReview(requestCaller, id, thread.id, head, version, body);
  const mutations = api.calls.filter(call => call.method === "POST").length;
  await assert.rejects(reply("Tested fix", { ...caller, session: "other" }), /another Discord/);
  await assert.rejects(reply("Tested fix", { ...caller, requester: { ...caller.requester, userId: "456" } }), /another Discord/);
  await assert.rejects(reply("Tested fix", { ...caller, requester: { ...caller.requester, guildId: "other" } }), /another Discord/);
  thread.pullRequest.repository.databaseId = 99;
  await assert.rejects(reply(), /does not belong/);
  thread.pullRequest.repository.databaseId = 1;
  thread.pullRequest.number = 99;
  await assert.rejects(reply(), /does not belong/);
  thread.pullRequest.number = 1;
  for (const body of ["", "x".repeat(6001), "@codex fix this", "-----BEGIN RSA PRIVATE KEY-----"]) await assert.rejects(reply(body));
  await assert.rejects(reply("Tested fix", caller, digest("old")), /head changed/);
  thread.comments.nodes[0].body = "Updated concern";
  await assert.rejects(reply(), /thread changed/);
  thread.comments.pageInfo.hasNextPage = true;
  await assert.rejects(reply(), /exceeds 100/);
  thread.comments.pageInfo.hasNextPage = false;
  thread.comments.nodes[0].pullRequestReview!.state = "PENDING";
  assert.equal((await service.reviews(caller, id)).threads[0].comments.length, 0);
  await assert.rejects(reply(), /published review/);
  thread.comments.nodes[0].pullRequestReview!.state = "COMMENTED";
  api.pulls[0].state = "closed";
  await assert.rejects(reply(), /closed/);
  assert.equal(api.calls.filter(call => call.method === "POST").length, mutations);
});

test("review resolution stops for new feedback, external commits, missing permissions, or revoked access", async t => {
  const { service, caller, api, published, fix, thread } = await reviewFixture(t);
  const fixed = await fix();
  const id = published.contribution_id;
  const version = (await service.reviews(caller, id)).threads[0].thread_version;
  await service.replyReview(caller, id, thread.id, fixed.head_sha, version, "Fixed and tested.");
  const latest = (await service.reviews(caller, id)).threads[0].thread_version;
  const resolve = () => service.resolveReview(caller, id, thread.id, fixed.head_sha, latest);
  thread.comments.nodes.push({ ...thread.comments.nodes[0], id: "new-concern", body: "Still broken" });
  await assert.rejects(resolve(), /thread changed/);
  thread.comments.nodes.pop();
  thread.viewerCanResolve = false;
  await assert.rejects(resolve(), /cannot resolve/);
  thread.viewerCanResolve = true;
  api.refs.set(api.pulls[0].head.ref, digest("external edit"));
  await assert.rejects(resolve(), /head changed/);
  api.refs.set(api.pulls[0].head.ref, fixed.head_sha);
  api.beforeRequest = async () => { process.env.AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS = "false"; };
  await assert.rejects(resolve(), /access/);
  assert.equal(thread.isResolved, false);
});

test("lost review reply responses recover without duplicating comments after restart", async t => {
  const { service, caller, api, config, published, thread } = await reviewFixture(t);
  const version = (await service.reviews(caller, published.contribution_id)).threads[0].thread_version;
  api.failAfterReply = true;
  await assert.rejects(service.replyReview(caller, published.contribution_id, thread.id, published.head_sha, version, "Investigating this finding."), /Lost reply/);
  const restarted = new GitHubContributions(config, api);
  const result = await restarted.replyReview(caller, published.contribution_id, thread.id, published.head_sha, version, "Investigating this finding.");
  assert.equal(result.already_replied, true);
  assert.equal(thread.comments.nodes.length, 2);
});

test("review listing paginates and returns thread versions without exposing pending feedback", async t => {
  const { service, caller, api, published, thread } = await reviewFixture(t);
  for (let index = 1; index < 26; index++) api.reviewThreads.push({ ...structuredClone(thread), id: `PRRT_${index}` });
  const first = await service.reviews(caller, published.contribution_id);
  assert.equal(first.threads.length, 25);
  assert.ok(first.next_cursor);
  const last = await service.reviews(caller, published.contribution_id, first.next_cursor!);
  assert.equal(last.threads.length, 1);
  assert.equal(last.next_cursor, null);
});

test("GraphQL uses only the publisher's scoped token and rejects partial errors without leaking their text", async t => {
  const { config } = fixture(t);
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  writeFileSync(config.publisher.keyFile, key); writeFileSync(config.writer.keyFile, key);
  const calls: { url: string; options?: RequestInit }[] = [];
  const api = new GitHubContributionApi(config, async (input, options) => {
    calls.push({ url: String(input), options });
    if (String(input).endsWith("/access_tokens")) return Response.json({ token: "installation-secret", expires_at: new Date(Date.now() + 3600000).toISOString(), repositories: [{ id: 1 }], permissions: { metadata: "read", contents: "read", pull_requests: "write" } });
    return Response.json({ data: { node: null }, errors: [{ message: "SECRET_RESPONSE_TOKEN" }] });
  });
  await assert.rejects(api.graphql(repository, REVIEW_THREAD_QUERY, { id: "PRRT_one" }, new AbortController().signal), error => error instanceof Error && /review operation failed/.test(error.message) && !error.message.includes("SECRET_RESPONSE_TOKEN"));
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { repository_ids: [1], permissions: { contents: "read", pull_requests: "write" } });
  assert.equal(calls[1].url, "https://api.github.com/graphql");
});
