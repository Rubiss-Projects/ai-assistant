import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubUserAuth, GitHubActionError, githubActionsEnabled, type UserGitHubClient } from "../src/common/githubUserAuth.js";
import { GitHubMaintainer, nextReleaseTag, type ActionTarget, type PullSnapshot, type ActionContext } from "../src/common/githubMaintainer.js";
import { canInvokeSlashCommand, canUseGitHubActions, createAccessPolicy } from "../src/common/accessPolicy.js";

function directory(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-actions-"));
  const previous = process.env.AI_ASSISTANT_WORKSPACE_ROOT;
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = path.join(root, "workspace");
  fs.mkdirSync(process.env.AI_ASSISTANT_WORKSPACE_ROOT);
  t.after(() => {
    if (previous === undefined) delete process.env.AI_ASSISTANT_WORKSPACE_ROOT; else process.env.AI_ASSISTANT_WORKSPACE_ROOT = previous;
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE; else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("device linking isolates two identities, encrypts tokens, and never falls back to the operator", async t => {
  const root = directory(t);
  let now = Date.now(), devices = 0;
  const requests: { path: string; authorization: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, authorization: headers.get("authorization") });
    if (url.pathname === "/login/device/code") return Response.json({ device_code: String(++devices), user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    if (url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as { device_code?: string; refresh_token?: string };
      const id = body.device_code ?? body.refresh_token!.slice(4);
      return Response.json({ access_token: `ghu_${id}`, refresh_token: `ghr_${id}`, expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.pathname === "/user") {
      const id = Number(headers.get("authorization")!.slice(-1));
      return Response.json({ id, login: id === 1 ? "ben" : "contributor" });
    }
    return Response.json({ ok: true });
  };
  const auth = new GitHubUserAuth("Iv1.test-client-id", root, fetcher, () => now);
  const ben = await auth.begin("111", AbortSignal.timeout(1000));
  const contributor = await auth.begin("222", AbortSignal.timeout(1000));
  now += 1100;
  await assert.rejects(auth.finish("222", ben.id, AbortSignal.timeout(1000)), /another person/);
  await auth.finish("111", ben.id, AbortSignal.timeout(1000));
  await auth.finish("222", contributor.id, AbortSignal.timeout(1000));
  assert.deepEqual(auth.linked("111"), { id: 1, login: "ben" });
  assert.deepEqual(auth.linked("222"), { id: 2, login: "contributor" });
  const stored = fs.readFileSync(path.join(root, "accounts.json"), "utf8");
  assert.ok(!stored.includes("ghu_") && !stored.includes("ghr_") && !stored.includes("ben"));
  const restored = new GitHubUserAuth("Iv1.test-client-id", root, fetcher, () => now);
  const api = await restored.client("222", AbortSignal.timeout(1000), async () => {});
  await api.request("POST", "/repos/owner/repo/pulls/1/reviews", { event: "APPROVE" });
  assert.equal(requests.at(-1)?.authorization, "Bearer ghu_2");
  await assert.rejects(restored.client("333", AbortSignal.timeout(1000), async () => {}), /your own GitHub/);
  restored.unlink("222");
  await assert.rejects(api.request("POST", "/repos/owner/repo/pulls/1/reviews"), /your own GitHub/);
  assert.equal(restored.linked("111")?.login, "ben");
});

test("OAuth polling is rate-limited and an unlink cancels an in-flight link", async t => {
  const root = directory(t);
  let now = Date.now(), polls = 0;
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const auth = new GitHubUserAuth("Iv1.test-client-id", root, async input => {
    const url = String(input);
    if (url.endsWith("device/code")) return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    if (url.endsWith("access_token")) { polls++; await blocked; return Response.json({ access_token: "ghu_1", refresh_token: "ghr_1", expires_in: 28800, refresh_token_expires_in: 15897600 }); }
    return Response.json({ id: 1, login: "ben" });
  }, () => now);
  const pending = await auth.begin("111", AbortSignal.timeout(1000));
  await assert.rejects(auth.finish("111", pending.id, AbortSignal.timeout(1000)), /wait/);
  assert.equal(polls, 0);
  now += 6000;
  const finish = auth.finish("111", pending.id, AbortSignal.timeout(1000));
  auth.unlink("111"); resume();
  await assert.rejects(finish, /cancelled/);
  assert.equal(auth.linked("111"), undefined);
});

test("refresh is single-flight and revoked Discord permission prevents the GitHub write", async t => {
  const root = directory(t);
  let now = Date.now(), refreshes = 0, allowed = true, writes = 0;
  const auth = new GitHubUserAuth("Iv1.test-client-id", root, async (input, init) => {
    const url = String(input);
    if (url.endsWith("device/code")) return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    if (url.endsWith("access_token")) {
      if (String(init?.body).includes('"grant_type":"refresh_token"')) refreshes++;
      return Response.json({ access_token: "ghu_1", refresh_token: "ghr_1", expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith("/user")) return Response.json({ id: 1, login: "ben" });
    writes++; return Response.json({});
  }, () => now);
  const pending = await auth.begin("111", AbortSignal.timeout(1000)); now += 1100;
  await auth.finish("111", pending.id, AbortSignal.timeout(1000)); now += 28800_000;
  const authorize = async () => { if (!allowed) throw new Error("revoked"); };
  const [a, b] = await Promise.all([auth.client("111", AbortSignal.timeout(1000), authorize), auth.client("111", AbortSignal.timeout(1000), authorize)]);
  assert.equal(refreshes, 1); assert.deepEqual(a.user, b.user);
  allowed = false;
  await assert.rejects(a.request("POST", "/repos/owner/repo/pulls/1/reviews"), /revoked/);
  assert.equal(writes, 0);
});

const head = "a".repeat(40), base = "b".repeat(40), merged = "c".repeat(40);
function fixture(t: TestContext) {
  const root = directory(t);
  const target: ActionTarget = { id: "contribution", repository: { upstream: "Rubiss-Projects/ai-assistant", upstreamId: 1, fork: "fork/ai-assistant", forkId: 2 }, pull: 42,
    branch: "ai-assistant/contribution", baseBranch: "main", head, publisher: "publisher[bot]",
    review: { enabled: true, attempts: 1, limit: 20, budget_exhausted: false, state: "completed", head_sha: head, base_sha: base, result: { summary: "Clean", findings: [] }, error: undefined, review_url: "https://github.com/review" } };
  const pull: PullSnapshot = { id: "PR_42", title: "Change", state: "OPEN", isDraft: false, headRefOid: head, baseRefOid: base, baseRefName: "main",
    author: { __typename: "Bot", login: "publisher" }, headRefName: target.branch, headRepository: { databaseId: 2 }, mergeCommit: null,
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: false } }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } };
  const calls: { user: string; method: string; endpoint: string; body: unknown }[] = [];
  let lost = false, denial = false, emptyReceipt = false, main = merged, ci = "success", latest = "v1.9.0", runHead = merged;
  const auth = { client: async (user: string, _signal: AbortSignal, authorize: () => Promise<void>): Promise<UserGitHubClient> => ({
    user: { id: user === "ben" ? 1 : 2, login: user }, request: async <T>(method: "GET" | "POST" | "PUT", endpoint: string, raw?: unknown) => {
      await authorize(); calls.push({ user, method, endpoint, body: raw });
      let result: unknown;
      if (endpoint === "/graphql") {
        const body = raw as { query: string };
        if (body.query.startsWith("mutation")) { pull.isDraft = false; result = { data: { markPullRequestReadyForReview: { pullRequest: { id: pull.id } } } }; }
        else result = { data: { repository: { databaseId: 1, nameWithOwner: target.repository.upstream, defaultBranchRef: { name: "main" }, pullRequest: structuredClone(pull) } } };
      } else if (endpoint.endsWith("/reviews")) {
        if (denial) throw new GitHubActionError("denied", 403);
        pull.reviews.nodes.push({ author: { login: user }, state: "APPROVED", commit: { oid: head } });
        if (lost) throw new Error("connection lost");
        result = { id: 100 };
      } else if (endpoint.endsWith("/merge")) {
        pull.state = "MERGED"; pull.mergeCommit = { oid: merged }; result = { merged: true, sha: merged };
      } else if (endpoint.endsWith("/releases/latest")) result = { tag_name: latest };
      else if (endpoint.includes("/tags?")) result = [{ name: latest }, { name: "v1.10.0-beta.1" }];
      else if (endpoint.includes("/compare/")) result = { status: "ahead", total_commits: 2, commits: [{ commit: { message: "Other person's change" } }, { commit: { message: "This change" } }] };
      else if (endpoint.endsWith("/branches/main")) result = { commit: { sha: main } };
      else if (endpoint.includes("/ci.yml/runs")) result = { workflow_runs: [{ path: ".github/workflows/ci.yml", head_sha: merged, status: "completed", conclusion: ci }] };
      else if (endpoint.endsWith("/dispatches")) { if (lost) throw new Error("connection lost"); result = emptyReceipt ? undefined : { workflow_run_id: 123 }; }
      else if (endpoint.includes("/release.yml/runs")) result = { workflow_runs: [{ id: 123, display_title: `Release v1.9.1 @${merged}`, actor: { id: 1 }, head_sha: merged, created_at: new Date().toISOString() }] };
      else if (endpoint.endsWith("/actions/runs/123")) result = { path: ".github/workflows/release.yml", status: "completed", conclusion: "success", head_sha: runHead };
      else if (endpoint.includes("/releases/tags/")) result = { draft: false, tag_name: "v1.9.1" };
      else if (endpoint.includes("/git/ref/tags/")) result = { object: { type: "commit", sha: merged } };
      else result = { archived: false, permissions: { push: user === "ben" } };
      return result as T;
    },
  }) };
  const context = (user = "ben"): ActionContext => ({ userId: user, guild: "guild", channel: "channel", signal: AbortSignal.timeout(10_000), authorize: async action => {
    if (user !== "ben" && (action === "merge" || action === "release")) throw new GitHubActionError("maintainer permission required");
  } });
  const make = () => new GitHubMaintainer(auth, () => [target], root);
  const service = make();
  const card = service.forConversation("session", "guild", "channel")[0];
  return { service, card, pull, target, calls, context, make, setLost: (value: boolean) => { lost = value; }, setDenial: (value: boolean) => { denial = value; }, setEmptyReceipt: () => { emptyReceipt = true; }, setMain: (value: string) => { main = value; }, setCI: (value: string) => { ci = value; }, setLatest: (value: string) => { latest = value; }, setRunHead: (value: string) => { runHead = value; } };
}

test("contributors approve as themselves; their approval never grants merge or release", async t => {
  const f = fixture(t);
  assert.match(await f.service.act(f.card.id, "approve", f.context("contributor")), /as @contributor/);
  assert.equal(f.calls.find(call => call.endpoint.endsWith("/reviews"))?.user, "contributor");
  await assert.rejects(f.service.act(f.card.id, "merge", f.context("contributor")), /maintainer/);
  await assert.rejects(f.service.act(f.card.id, "release", f.context("contributor")), /maintainer/);
  await assert.rejects(f.service.act(f.card.id, "merge", f.context()), /Approve this revision/);
  await f.service.act(f.card.id, "approve", f.context());
  await f.service.act(f.card.id, "merge", f.context());
  assert.deepEqual(f.calls.find(call => call.endpoint.endsWith("/merge"))?.body, { sha: head, merge_method: "rebase" });
});

test("Discord permission cannot substitute for GitHub repository write permission", async t => {
  const f = fixture(t);
  await f.service.act(f.card.id, "approve", f.context("contributor"));
  await assert.rejects(f.service.act(f.card.id, "merge", { ...f.context("contributor"), authorize: async () => {} }), /write access/);
  assert.ok(!f.calls.some(call => call.endpoint.endsWith("/merge")));
});

test("stale, foreign, unreviewed, incomplete, and failing PRs cannot be approved", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.act(f.card.id, "approve", { ...f.context(), channel: "another-channel" }), /another conversation/);
  f.pull.headRefOid = merged;
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /PR changed/);
  f.pull.headRefOid = head; f.pull.baseRefOid = merged;
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /current head and base/);
  f.pull.baseRefOid = base; f.pull.reviewThreads.nodes = [{ isResolved: false }];
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /remaining review/);
  f.pull.reviewThreads.nodes = []; f.pull.reviews.pageInfo.hasPreviousPage = true;
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /review limit/);
  f.pull.reviews.pageInfo.hasPreviousPage = false; f.pull.commits.nodes[0].commit.statusCheckRollup!.state = "PENDING";
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /checks/);
  f.pull.author = { __typename: "User", login: "publisher" };
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /author/);
  assert.ok(!f.calls.some(call => call.endpoint.endsWith("/reviews")));
});

test("double clicks and restart after a lost approval response do not post twice", async t => {
  const f = fixture(t); f.setLost(true);
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /connection lost/);
  f.setLost(false);
  const restored = f.make();
  const results = await Promise.all([restored.act(f.card.id, "approve", f.context()), restored.act(f.card.id, "approve", f.context())]);
  assert.ok(results.every(result => result.includes("already approved")));
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("/reviews")).length, 1);
});

test("a GitHub rejection can be retried without leaving a false pending operation", async t => {
  const f = fixture(t); f.setDenial(true);
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /denied/);
  f.setDenial(false);
  assert.match(await f.service.act(f.card.id, "approve", f.context()), /Approval submitted/);
});

test("a release previews all changes and binds dispatch to the merged SHA and proposed version", async t => {
  const f = fixture(t);
  f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await assert.rejects(f.service.act(f.card.id, "release", f.context()), /preview/);
  await f.service.refresh(f.card.id, f.context());
  assert.match(f.card.release!.notes, /Other person's change/);
  assert.equal(f.card.release!.tag, "v1.9.1");
  f.setMain(base);
  await assert.rejects(f.service.act(f.card.id, "release", f.context()), /Main changed/);
  f.setMain(merged); f.setCI("failure");
  await assert.rejects(f.service.act(f.card.id, "release", f.context()), /CI must pass/);
  f.setCI("success");
  await f.service.act(f.card.id, "release", f.context());
  assert.deepEqual(f.calls.find(call => call.endpoint.endsWith("/dispatches"))?.body, { ref: "main", inputs: { tag: "v1.9.1", expected_sha: merged } });
  await assert.rejects(f.make().act(f.card.id, "release", f.context()), /already sent/);
  f.setRunHead(base);
  await assert.rejects(f.service.refresh(f.card.id, f.context()), /identity or commit/);
  assert.notEqual(f.card.release!.state, "success");
  f.setRunHead(merged);
  await f.service.refresh(f.card.id, f.context());
  assert.equal(f.card.release!.state, "success");
  assert.match(f.card.release!.url!, /releases\/tag\/v1.9.1/);
});

test("refresh replaces an undispatched release preview when another release is published", async t => {
  const f = fixture(t); f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await f.service.refresh(f.card.id, f.context());
  f.setLatest("v1.9.1");
  await assert.rejects(f.service.act(f.card.id, "release", f.context()), /Another release/);
  await f.service.refresh(f.card.id, f.context());
  assert.equal(f.card.release?.tag, "v1.9.2");
  assert.equal(f.card.release?.previous, "v1.9.1");
  assert.ok(!f.calls.some(call => call.endpoint.endsWith("/dispatches")));
});

test("lost dispatch receipts reconcile by version, commit, actor, and time without re-dispatch", async t => {
  const f = fixture(t); f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await f.service.refresh(f.card.id, f.context()); f.setLost(true);
  await assert.rejects(f.service.act(f.card.id, "release", f.context()), /connection lost/);
  f.setLost(false); const restored = f.make();
  const { card } = await restored.refresh(f.card.id, f.context());
  assert.equal(card.release?.state, "success");
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("/dispatches")).length, 1);
});

test("merge and release rights do not inherit open chat or legacy admin access", () => {
  const open = createAccessPolicy({ GITHUB_CONTRIBUTIONS_ACCESS: "chat" });
  const user = { userId: "111", guildId: "guild" };
  assert.equal(open.can(user, "github.contribute"), true);
  assert.equal(open.can(user, "github.merge"), false);
  assert.equal(open.can(user, "github.release"), false);
  const admin = createAccessPolicy({ DISCORD_ADMIN_USERS: "111" });
  assert.equal(admin.can(user, "github.merge"), true);
  assert.equal(admin.can(user, "github.release"), true);
  assert.equal(admin.can({ userId: "111" }, "github.release"), false);
});

test("an accepted dispatch without a receipt reports pending publication and never resends", async t => {
  const f = fixture(t); f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await f.service.refresh(f.card.id, f.context()); f.setEmptyReceipt();
  assert.match(await f.service.act(f.card.id, "release", f.context()), /requested as @ben.*receipt is pending/);
  const restored = f.make();
  await assert.rejects(restored.act(f.card.id, "release", f.context()), /already sent/);
  assert.equal((await restored.refresh(f.card.id, f.context())).card.release?.state, "success");
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("/dispatches")).length, 1);
});

test("merge-only and release-only grants admit linking without granting approval or contribution", t => {
  const root = directory(t), rights = path.join(root, "rights.json");
  for (const capability of ["github.merge", "github.release"]) {
    fs.writeFileSync(rights, JSON.stringify({ grants: [{ guildId: "123", roleId: "456", capabilities: [capability] }] }));
    const access = createAccessPolicy({ DISCORD_RIGHTS_FILE: rights, GITHUB_CONTRIBUTIONS_ACCESS: "granted", DISCORD_ADMIN_USERS: "999" });
    const subject = { userId: "111", guildId: "123", roleIds: ["456"] };
    assert.equal(canUseGitHubActions(access, subject), true);
    assert.equal(access.can(subject, "github.contribute"), false);
    assert.equal(canInvokeSlashCommand(access, subject.userId, { commandName: "github", subcommand: "link" }, subject), true);
    assert.equal(canUseGitHubActions(access, { ...subject, roleIds: [] }), false);
    assert.equal(canUseGitHubActions(access, { ...subject, guildId: "789" }), false);
  }
});

test("enabled GitHub actions require enabled contributions and server reviews at startup", () => {
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_GITHUB_ACTIONS: "true", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true" };
  assert.throws(() => githubActionsEnabled(env), /server-side Codex reviews/);
  assert.throws(() => githubActionsEnabled({ ...env, AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "false" }), /server-side Codex reviews/);
  assert.equal(githubActionsEnabled({ ...env, AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true" }), true);
  assert.equal(githubActionsEnabled({ AI_ASSISTANT_ENABLE_GITHUB_ACTIONS: "false" }), false);
});

test("version selection orders numbers and excludes prereleases", () => {
  assert.equal(nextReleaseTag(["v1.9.10", "v1.10.1", "v2.0.0-beta.1"]), "v1.10.2");
});
