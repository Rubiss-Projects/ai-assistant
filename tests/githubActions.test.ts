import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubUserAuth, GitHubActionError, GitHubRequestNotSentError, githubActionsEnabled, type UserGitHubClient } from "../src/common/githubUserAuth.js";
import { GitHubMaintainer, nextReleaseTag, type ActionTarget, type PullSnapshot, type ActionContext } from "../src/common/githubMaintainer.js";
import { canInvokeSlashCommand, canUseGitHubActions, createAccessPolicy } from "../src/common/accessPolicy.js";
import { DiscordGitHub, githubCardMessage } from "../src/adapters/discord/github.js";
import type { Client } from "discord.js";

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
  await assert.rejects(a.request("POST", "/repos/owner/repo/pulls/1/reviews"), GitHubRequestNotSentError);
  assert.equal(writes, 0);
});

test("Finish linking retries identity lookup without exchanging a consumed device code again", async t => {
  const root = directory(t);
  let now = Date.now(), exchanges = 0, identityFailure = true;
  const auth = new GitHubUserAuth("Iv1.test-client-id", root, async input => {
    const url = String(input);
    if (url.endsWith("device/code")) return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    if (url.endsWith("access_token")) {
      assert.equal(++exchanges, 1, "the one-time device grant must not be exchanged twice");
      return Response.json({ access_token: "ghu_1", refresh_token: "ghr_1", expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    return identityFailure ? new Response(null, { status: 503 }) : Response.json({ id: 1, login: "ben" });
  }, () => now);
  const pending = await auth.begin("111", AbortSignal.timeout(1000)); now += 1100;
  await assert.rejects(auth.finish("111", pending.id, AbortSignal.timeout(1000)), /503/);
  assert.equal(auth.linked("111"), undefined);
  await assert.rejects(auth.client("111", AbortSignal.timeout(1000), async () => {}), /Link your own/);
  identityFailure = false; now += 1100;
  assert.deepEqual(await auth.finish("111", pending.id, AbortSignal.timeout(1000)), { id: 1, login: "ben" });
  assert.equal(exchanges, 1);
});

test("rotated credentials survive failed identity lookup and restart without permitting an unverified write", async t => {
  const root = directory(t);
  let now = Date.now(), refreshes = 0, identityFailure = false, identityId = 1, writes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("device/code")) return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    if (url.endsWith("access_token")) {
      const body = JSON.parse(String(init?.body)) as { grant_type: string; refresh_token?: string };
      if (body.grant_type === "refresh_token") {
        assert.equal(body.refresh_token, `ghr_${refreshes}`);
        refreshes++;
      }
      return Response.json({ access_token: `ghu_${refreshes}`, refresh_token: `ghr_${refreshes}`, expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith("/user")) {
      if (identityFailure) return new Response(null, { status: 503 });
      return Response.json({ id: identityId, login: "ben" });
    }
    writes++; return Response.json({});
  };
  const auth = new GitHubUserAuth("Iv1.test-client-id", root, fetcher, () => now);
  const pending = await auth.begin("111", AbortSignal.timeout(1000)); now += 1100;
  await auth.finish("111", pending.id, AbortSignal.timeout(1000));
  const client = await auth.client("111", AbortSignal.timeout(1000), async () => {});
  now += 28800_000; identityFailure = true;
  await assert.rejects(client.request("POST", "/repos/owner/repo/pulls/1/reviews"), /503/);
  assert.equal(refreshes, 1); assert.equal(writes, 0);
  const restored = new GitHubUserAuth("Iv1.test-client-id", root, fetcher, () => now);
  await assert.rejects(restored.client("111", AbortSignal.timeout(1000), async () => {}), /503/);
  identityFailure = false; identityId = 2;
  await assert.rejects(restored.client("111", AbortSignal.timeout(1000), async () => {}), /identity changed/);
  identityId = 1;
  const recovered = await restored.client("111", AbortSignal.timeout(1000), async () => {});
  await recovered.request("POST", "/repos/owner/repo/pulls/1/reviews");
  assert.equal(refreshes, 1); assert.equal(writes, 1);
  now += 28800_000;
  await recovered.request("POST", "/repos/owner/repo/pulls/1/reviews");
  assert.equal(refreshes, 2);
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
  const tag = { object: { type: "commit", sha: merged } };
  const tagObjects = new Map<string, typeof tag>();
  let graphqlResponse: unknown;
  let lost = false, denial = false, unsent = false, mergeDenied = false, emptyReceipt = false, main = merged, ci = "success", latest = "v1.9.0", runHead = merged, runConclusion = "success";
  const auth = { client: async (user: string, _signal: AbortSignal, authorize: () => Promise<void>): Promise<UserGitHubClient> => ({
    user: { id: user === "ben" ? 1 : 2, login: user }, request: async <T>(method: "GET" | "POST" | "PUT", endpoint: string, raw?: unknown) => {
      await authorize(); calls.push({ user, method, endpoint, body: raw });
      if (unsent && /\/(reviews|merge|dispatches)$/.test(endpoint)) throw new GitHubRequestNotSentError("Permission was revoked before transport.");
      let result: unknown;
      if (endpoint === "/graphql") {
        const body = raw as { query: string };
        if (body.query.startsWith("mutation")) {
          if (graphqlResponse) return graphqlResponse as T;
          if (unsent) throw new GitHubRequestNotSentError("not sent");
          if (denial) throw new GitHubActionError("denied", 403);
          pull.isDraft = false;
          if (lost) throw new Error("connection lost"); result = { data: { markPullRequestReadyForReview: { pullRequest: { id: pull.id } } } }; }
        else result = { data: { repository: { databaseId: 1, nameWithOwner: target.repository.upstream, defaultBranchRef: { name: "main" }, pullRequest: structuredClone(pull) } } };
      } else if (endpoint.endsWith("/reviews")) {
        if (denial) throw new GitHubActionError("denied", 403);
        pull.reviews.nodes.push({ author: { login: user }, state: "APPROVED", commit: { oid: head } });
        if (lost) throw new Error("connection lost");
        result = { id: 100 };
      } else if (endpoint.endsWith("/merge")) {
        if (mergeDenied) result = { merged: false, sha: "" };
        else { pull.state = "MERGED"; pull.mergeCommit = { oid: merged }; result = { merged: true, sha: merged }; }
      } else if (endpoint.endsWith("/releases/latest")) result = { tag_name: latest };
      else if (endpoint.includes("/tags?")) result = [{ name: latest }, { name: "v1.10.0-beta.1" }];
      else if (endpoint.includes("/compare/")) result = { status: "ahead", total_commits: 2, commits: [{ commit: { message: "Other person's change" } }, { commit: { message: "This change" } }] };
      else if (endpoint.endsWith("/branches/main")) result = { commit: { sha: main } };
      else if (endpoint.includes("/ci.yml/runs")) result = { workflow_runs: [{ path: ".github/workflows/ci.yml", head_sha: merged, status: "completed", conclusion: ci }] };
      else if (endpoint.endsWith("/dispatches")) { if (lost) throw new Error("connection lost"); result = emptyReceipt ? undefined : { workflow_run_id: 123 }; }
      else if (endpoint.includes("/release.yml/runs")) result = { workflow_runs: [{ id: 123, display_title: `Release v1.9.1 @${merged}`, actor: { id: 1 }, head_sha: merged, created_at: new Date().toISOString() }] };
      else if (endpoint.endsWith("/actions/runs/123")) result = { path: ".github/workflows/release.yml", status: "completed", conclusion: runConclusion, head_sha: runHead };
      else if (endpoint.includes("/releases/tags/")) result = { draft: false, tag_name: "v1.9.1" };
      else if (endpoint.includes("/git/ref/tags/")) result = tag;
      else if (endpoint.includes("/git/tags/")) { result = tagObjects.get(endpoint.split("/").at(-1)!); assert.ok(result, "Expected a known annotated tag object"); }
      else result = { archived: false, permissions: { push: user === "ben" } };
      return result as T;
    },
  }) };
  const context = (user = "ben"): ActionContext => ({ userId: user, guild: "guild", channel: "channel", signal: AbortSignal.timeout(10_000), authorize: async action => {
    if (user !== "ben" && (action === "ready" || action === "merge" || action === "release")) throw new GitHubActionError("maintainer permission required");
  } });
  const make = () => new GitHubMaintainer(auth, () => [target], root);
  const service = make();
  const card = service.forConversation("session", "guild", "channel")[0];
  return { root, service, card, pull, target, calls, context, make, tag, tagObjects, setGraphqlResponse: (value: unknown) => { graphqlResponse = value; }, setLost: (value: boolean) => { lost = value; }, setDenial: (value: boolean) => { denial = value; }, setUnsent: (value: boolean) => { unsent = value; }, setMergeDenied: (value: boolean) => { mergeDenied = value; }, setEmptyReceipt: () => { emptyReceipt = true; }, setMain: (value: string) => { main = value; }, setCI: (value: string) => { ci = value; }, setLatest: (value: string) => { latest = value; }, setRunHead: (value: string) => { runHead = value; }, setRunConclusion: (value: string) => { runConclusion = value; } };
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

test("contributors can approve a draft, and a maintainer makes it ready only during merge", async t => {
  const f = fixture(t); f.pull.isDraft = true;
  await f.service.act(f.card.id, "approve", f.context("contributor"));
  await f.service.act(f.card.id, "approve", f.context());
  assert.equal(f.pull.isDraft, true);
  await f.service.act(f.card.id, "merge", f.context());
  assert.equal(f.pull.isDraft, false); assert.equal(f.pull.state, "MERGED");
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("/reviews")).length, 2);
});

test("a definitive non-merge response clears the receipt so a later merge can succeed", async t => {
  const f = fixture(t);
  await f.service.act(f.card.id, "approve", f.context());
  f.setMergeDenied(true);
  await assert.rejects(f.service.act(f.card.id, "merge", f.context()), /did not merge/);
  const restored = f.make();
  assert.ok(!restored.get(f.card.id, f.context()).attempts.some(attempt => attempt.action === "merge"));
  f.setMergeDenied(false);
  await restored.act(f.card.id, "merge", f.context());
  assert.equal(f.pull.state, "MERGED");
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

test("a blocked card does not delay another card while clicks on the same card remain serialized", async t => {
  const f = fixture(t);
  const other = f.service.forConversation("session", "guild", "other-channel")[0];
  let resume!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const first = f.service.refresh(f.card.id, { ...f.context(), authorize: async () => { started(); await blocked; } });
  await entered;
  let sameCardEntered = false;
  const second = f.service.refresh(f.card.id, { ...f.context(), authorize: async () => { sameCardEntered = true; } });
  try {
    await Promise.race([
      f.service.refresh(other.id, { ...f.context(), channel: "other-channel" }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("unrelated card was blocked")), 1000); timer.unref(); }),
    ]);
    assert.equal(sameCardEntered, false);
  } finally { resume(); await Promise.all([first, second]); }
  assert.equal(sameCardEntered, true);
});

test("release polling reaches later cards even when ten old receipts remain unresolved", t => {
  const f = fixture(t);
  const cards = Array.from({ length: 11 }, (_, index) => {
    const card = f.service.forConversation("session", "guild", `channel-${index}`)[0];
    card.release = { tag: "v1.9.1", sha: merged, previous: "v1.9.0", notes: "Change" };
    card.attempts.push({ action: "release", user: 1, discordUser: "ben", state: "pending", at: Date.now() });
    return card;
  });
  assert.equal(f.service.pendingReleases().length, 10);
  assert.ok(f.service.pendingReleases().some(card => card.id === cards[10].id));
  for (const card of cards.slice(0, 10)) card.release!.state = "success";
  assert.deepEqual(f.service.pendingReleases().map(card => card.id), [cards[10].id]);
});

test("a GitHub rejection can be retried without leaving a false pending operation", async t => {
  const f = fixture(t); f.setDenial(true);
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /denied/);
  f.setDenial(false);
  assert.match(await f.service.act(f.card.id, "approve", f.context()), /Approval submitted/);
});

test("a pre-transport failure leaves approval, merge, and release retryable", async t => {
  const f = fixture(t);
  for (const action of ["approve", "merge", "release"] as const) {
    if (action === "release") await f.service.refresh(f.card.id, f.context());
    f.setUnsent(true);
    await assert.rejects(f.service.act(f.card.id, action, f.context()), GitHubRequestNotSentError);
    assert.ok(!f.make().get(f.card.id, f.context()).attempts.some(attempt => attempt.action === action));
    f.setUnsent(false);
    await f.service.act(f.card.id, action, f.context());
  }
});

test("refresh persists closed PR state and disables mutations until the PR reopens", async t => {
  const f = fixture(t); f.pull.state = "CLOSED";
  await f.service.refresh(f.card.id, f.context());
  const restored = f.make().get(f.card.id, f.context());
  assert.equal(restored.closed, true);
  const message = githubCardMessage(restored, true);
  assert.match(message.content, /Closed without merging/);
  assert.ok(message.components[0].toJSON().components.slice(0, 3).every(button => button.disabled));
  f.pull.state = "OPEN";
  await f.service.refresh(f.card.id, f.context());
  assert.equal(f.card.closed, false);
  assert.equal(githubCardMessage(f.card, true).components[0].toJSON().components[0].disabled, false);
});

test("status presents current cards even when an older card cannot refresh", async t => {
  const f = fixture(t), root = f.root;
  const priorDirectory = process.env.GITHUB_ACTIONS_STATE_DIR, priorClient = process.env.GITHUB_USER_APP_CLIENT_ID;
  process.env.GITHUB_ACTIONS_STATE_DIR = root; process.env.GITHUB_USER_APP_CLIENT_ID = "Iv1.test-client-id";
  t.after(() => {
    if (priorDirectory === undefined) delete process.env.GITHUB_ACTIONS_STATE_DIR; else process.env.GITHUB_ACTIONS_STATE_DIR = priorDirectory;
    if (priorClient === undefined) delete process.env.GITHUB_USER_APP_CLIENT_ID; else process.env.GITHUB_USER_APP_CLIENT_ID = priorClient;
  });
  const adapter = new DiscordGitHub();
  const current = { ...f.card, id: "current-card", pull: 43 };
  t.mock.method(adapter.actions, "forConversation", () => [f.card, current]);
  t.mock.method(adapter.auth, "linked", () => ({ id: 1, login: "ben" }));
  t.mock.method(adapter.actions, "refresh", async (id: string) => {
    if (id === f.card.id) throw new GitHubActionError("Historical release is superseded.");
    return { card: current, pull: f.pull, actor: "ben" };
  });
  t.mock.method(adapter.actions, "reviewReady", () => true);
  const saved = t.mock.method(adapter.actions, "setMessage", () => {});
  const sent: { content: string }[] = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true, isSendable: () => true, isDMBased: () => false, guildId: "guild",
    send: async (message: { content: string }) => { sent.push(message); return { id: "message" }; },
  }) } } as unknown as Client;
  const failed = await adapter.present(client, "session", "guild", "channel", f.context());
  assert.deepEqual(failed, ["Rubiss-Projects/ai-assistant #42"]);
  assert.equal(sent.length, 1); assert.match(sent[0].content, /#43/);
  assert.equal(saved.mock.callCount(), 1);
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

test("release verification peels annotated tags and rejects mismatched or non-commit targets", async t => {
  const f = fixture(t); f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await f.service.refresh(f.card.id, f.context());
  await f.service.act(f.card.id, "release", f.context());
  const outer = "d".repeat(40), inner = "e".repeat(40);
  f.tag.object = { type: "tag", sha: outer };
  f.tagObjects.set(outer, { object: { type: "tag", sha: inner } });
  const target = { object: { type: "commit", sha: base } };
  f.tagObjects.set(inner, target);
  await assert.rejects(f.service.refresh(f.card.id, f.context()), /release commit could not be verified/);
  target.object = { type: "tree", sha: merged };
  await assert.rejects(f.service.refresh(f.card.id, f.context()), /release commit could not be verified/);
  target.object = { type: "tag", sha: outer };
  await assert.rejects(f.service.refresh(f.card.id, f.context()), /release commit could not be verified/);
  assert.notEqual(f.card.release?.state, "success");
  target.object = { type: "commit", sha: merged };
  const restored = f.make();
  assert.equal((await restored.refresh(f.card.id, f.context())).card.release?.state, "success");
  assert.deepEqual(restored.pendingReleases(), []);
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("/dispatches")).length, 1);
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

test("a release startup failure is terminal across restarts", async t => {
  const f = fixture(t); f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await f.service.refresh(f.card.id, f.context());
  await f.service.act(f.card.id, "release", f.context());
  f.setRunConclusion("startup_failure");
  await f.service.refresh(f.card.id, f.context());
  assert.equal(f.card.release?.state, "startup_failure");
  assert.deepEqual(f.service.pendingReleases(), []);
  assert.deepEqual(f.make().pendingReleases(), []);
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

test("new revisions and review bases reuse one public card message", async t => {
  const f = fixture(t);
  f.service.setMessage(f.card, "one-message");
  f.target.head = merged;
  const revised = f.service.forConversation("session", "guild", "channel")[0];
  assert.notEqual(revised.id, f.card.id);
  assert.equal(revised.message, "one-message");
  assert.deepEqual(revised.attempts, []);
  assert.ok("base_sha" in f.target.review);
  f.target.review.base_sha = merged;
  const reviewed = f.service.forConversation("session", "guild", "channel")[0];
  assert.equal(reviewed.message, "one-message");
  assert.equal(f.make().forConversation("session", "guild", "channel")[0].id, reviewed.id);
  await assert.rejects(f.service.act(f.card.id, "approve", f.context()), /PR changed/);
});

function adapterFixture(t: TestContext) {
  const f = fixture(t);
  const values = { GITHUB_ACTIONS_STATE_DIR: f.root, GITHUB_USER_APP_CLIENT_ID: "Iv1.test-client-id",
    AI_ASSISTANT_ENABLE_GITHUB_ACTIONS: "true", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true", DISCORD_ADMIN_USERS: "ben" };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const adapter = new DiscordGitHub();
  Object.defineProperty(adapter, "actions", { value: f.service });
  const sent: any[] = [], edited: any[] = [];
  const member = { roles: { cache: new Map() } };
  const guild = { members: { cache: new Map([["ben", member]]), fetch: async () => member } };
  const existing = { id: "one-message", author: { id: "bot" }, edit: async (value: unknown) => { edited.push(value); } };
  const channel = { isTextBased: () => true, isSendable: () => true, isDMBased: () => false, guildId: "guild", guild,
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => existing },
    send: async (value: unknown) => { sent.push(value); return { id: "one-message" }; } };
  const client = { user: { id: "bot" }, guilds: { fetch: async () => guild }, channels: { fetch: async () => channel } } as unknown as Client;
  return { ...f, adapter, client, sent, edited, channel };
}

test("simultaneous presentation and later revisions send one card, then edit it", async t => {
  const f = adapterFixture(t);
  await Promise.all(Array.from({ length: 3 }, () => f.adapter.present(f.client, "session", "guild", "channel")));
  assert.equal(f.sent.length, 1);
  assert.equal(f.edited.length, 2);
  f.target.head = merged;
  await f.adapter.present(f.client, "session", "guild", "channel");
  assert.equal(f.sent.length, 1);
  assert.equal(f.edited.length, 3);
});

test("transient card fetch errors never send duplicates; deleted cards are replaced", async t => {
  const f = adapterFixture(t); f.service.setMessage(f.card, "old-message");
  let error: unknown = new Error("Discord temporarily unavailable");
  t.mock.method(f.channel.messages, "fetch", async () => { throw error; });
  assert.equal((await f.adapter.present(f.client, "session", "guild", "channel")).length, 1);
  assert.equal(f.sent.length, 0);
  error = { code: 50001 }; // Missing Access
  await f.adapter.present(f.client, "session", "guild", "channel");
  assert.equal(f.sent.length, 0);
  error = { code: 10008 }; // Unknown Message
  await f.adapter.present(f.client, "session", "guild", "channel");
  assert.equal(f.sent.length, 1);
  assert.equal(f.card.message, "one-message");
});

test("ready for review requires maintainer and GitHub write access, review and checks", async t => {
  const f = fixture(t); f.pull.isDraft = true;
  await assert.rejects(f.service.act(f.card.id, "ready", f.context("contributor")), /maintainer/);
  await assert.rejects(f.service.act(f.card.id, "ready", { ...f.context("contributor"), authorize: async () => {} }), /write access/);
  f.pull.commits.nodes[0].commit.statusCheckRollup!.state = "PENDING";
  await assert.rejects(f.service.act(f.card.id, "ready", f.context()), /checks/);
  f.pull.commits.nodes[0].commit.statusCheckRollup!.state = "SUCCESS";
  const results = await Promise.all([f.service.act(f.card.id, "ready", f.context()), f.service.act(f.card.id, "ready", f.context())]);
  assert.match(results[0], /Marked ready for review/); assert.match(results[1], /already ready/);
  assert.equal(f.pull.isDraft, false);
  assert.equal(f.pull.state, "OPEN");
  assert.equal(f.calls.filter(call => (call.body as any)?.query?.startsWith("mutation")).length, 1);
  assert.equal(f.card.attempts[0].notification?.content.includes("marked ready for review"), true);
  const buttons = githubCardMessage(f.card, true).components.flatMap(row => row.toJSON().components);
  assert.equal(buttons.find(button => button.custom_id?.startsWith("gh:ready:"))?.disabled, true);
  assert.ok(githubCardMessage(f.card, true).components.every(row => row.toJSON().components.length <= 5));
});

test("a lost ready response reconciles after restart without another mutation", async t => {
  const f = fixture(t); f.pull.isDraft = true; f.setLost(true);
  await assert.rejects(f.service.act(f.card.id, "ready", f.context()), /connection lost/);
  f.setLost(false);
  const restored = f.make();
  await restored.refresh(f.card.id, f.context());
  assert.match(await restored.act(f.card.id, "ready", f.context()), /already ready/);
  assert.equal(f.calls.filter(call => (call.body as any)?.query?.startsWith("mutation")).length, 1);
  assert.equal(restored.pendingNotifications().length, 1);
});

test("success notifications survive restarts and Discord failures without repeating actions", async t => {
  const f = adapterFixture(t); f.pull.isDraft = true;
  await f.service.act(f.card.id, "ready", f.context());
  await f.service.act(f.card.id, "approve", f.context());
  await f.service.act(f.card.id, "merge", f.context());
  let fail = true;
  t.mock.method(f.channel, "send", async (value: unknown) => {
    if (fail) throw new Error("Discord unavailable");
    f.sent.push(value); return { id: String(f.sent.length) };
  });
  await assert.rejects(f.adapter.notify(f.client, f.card), /Discord unavailable/);
  assert.equal(f.service.pendingNotifications().length, 1);
  fail = false;
  const restored = f.make(); Object.defineProperty(f.adapter, "actions", { value: restored });
  const card = restored.get(f.card.id, f.context());
  await Promise.all([f.adapter.notify(f.client, card), f.adapter.notify(f.client, card)]);
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[0].content, /marked ready for review/);
  assert.match(f.sent[1].content, /approved revision/);
  assert.match(f.sent[2].content, /merged/);
  for (const sent of f.sent) { assert.equal(sent.enforceNonce, true); assert.deepEqual(sent.allowedMentions, { parse: [] }); }
  assert.equal(f.make().pendingNotifications().length, 0);
});

test("release notification waits for verified publication and retries after terminal success", async t => {
  const f = adapterFixture(t); f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await f.service.refresh(f.card.id, f.context());
  await f.service.act(f.card.id, "release", f.context());
  await f.adapter.notify(f.client, f.card);
  assert.equal(f.sent.length, 0);
  f.setRunConclusion("failure"); await f.service.refresh(f.card.id, f.context());
  assert.equal(f.service.pendingNotifications().length, 0);
  f.setRunConclusion("success"); await f.service.refresh(f.card.id, f.context());
  assert.equal(f.service.pendingReleases().length, 0);
  assert.equal(f.make().pendingNotifications().length, 1);
  await f.adapter.notify(f.client, f.card);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /released as \*\*v1.9.1\*\*/);
  await f.service.refresh(f.card.id, f.context());
  await f.adapter.notify(f.client, f.card);
  assert.equal(f.sent.length, 1);
});

test("button clicks announce success publicly even if the card edit fails", async t => {
  const f = adapterFixture(t); f.pull.isDraft = true; f.service.setMessage(f.card, "one-message");
  t.mock.method(f.adapter.auth, "linked", () => ({ id: 1, login: "ben" }));
  const replies: any[] = [];
  const interaction = { client: f.client, user: { id: "ben" }, guildId: "guild", channelId: "channel",
    customId: `gh:ready:${f.card.id}`, deferReply: async () => {}, isChatInputCommand: () => false,
    editReply: async (message: unknown) => { replies.push(message); },
    message: { id: "one-message", author: { id: "bot" }, edit: async () => { throw new Error("edit failed"); } } };
  await f.adapter.handle(interaction as never);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /marked ready for review/);
  assert.match(replies[0], /Marked ready for review as @ben/);
  await f.adapter.handle(interaction as never);
  assert.equal(f.sent.length, 1); assert.match(replies[1], /already ready/);
});

test("background polling delivers release success without a card message and retries notifications", async t => {
  const f = adapterFixture(t); f.pull.state = "MERGED"; f.pull.mergeCommit = { oid: merged };
  await f.service.refresh(f.card.id, f.context());
  await f.service.act(f.card.id, "release", f.context());
  let fail = true;
  t.mock.method(f.channel, "send", async (value: unknown) => {
    if (fail) throw new Error("temporary send error");
    f.sent.push(value); return { id: "notification" };
  });
  await (f.adapter as any).poll(f.client);
  assert.equal(f.card.release?.state, "success");
  assert.equal(f.sent.length, 0);
  fail = false;
  await (f.adapter as any).poll(f.client);
  await (f.adapter as any).poll(f.client);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /released as/);
});

test("ready failures before transport remain retryable and never announce success", async t => {
  const f = fixture(t); f.pull.isDraft = true; f.setUnsent(true);
  await assert.rejects(f.service.act(f.card.id, "ready", f.context()), GitHubRequestNotSentError);
  assert.deepEqual(f.card.attempts, []); assert.deepEqual(f.service.pendingNotifications(), []);
  f.setUnsent(false); f.setDenial(true);
  await assert.rejects(f.service.act(f.card.id, "ready", f.context()), /denied/);
  assert.deepEqual(f.card.attempts, []);
  f.setDenial(false);
  await f.service.act(f.card.id, "ready", f.context());
  assert.equal(f.service.pendingNotifications().length, 1);
});

test("Discord cards are presented only after generation and final response delivery", async t => {
  const f = adapterFixture(t);
  const { discordGitHub } = await import("../src/adapters/discord/github.js");
  const { executeDiscordTurn } = await import("../src/adapters/discord/turn.js");
  const events: string[] = [];
  t.mock.method(discordGitHub()!, "present", async () => { events.push("card"); return []; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const sessions = { sendMessage: async () => { events.push("generating"); started(); await blocked; return { content: "Finished" }; } };
  const source = { id: "turn", guildId: "guild", channelId: "channel", author: { id: "ben" }, client: f.client };
  const turn = executeDiscordTurn(sessions as never, source, "session", "work", undefined, {}, async () => { events.push("final response"); });
  await entered;
  assert.deepEqual(events, ["generating"]);
  release(); await turn;
  assert.deepEqual(events, ["generating", "final response", "card"]);
});

for (const action of ["ready", "merge"] as const) test(`${action} retries a definitive HTTP 200 GraphQL rejection after permissions are corrected`, async t => {
  const f = fixture(t); f.pull.isDraft = true;
  if (action === "merge") await f.service.act(f.card.id, "approve", f.context());
  f.setGraphqlResponse({ data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
  await assert.rejects(f.service.act(f.card.id, action, f.context()), /GitHub rejected/);
  assert.ok(!f.make().get(f.card.id, f.context()).attempts.some(attempt => attempt.action === "ready"));
  assert.equal(f.pull.isDraft, true);
  assert.ok(!f.card.attempts.some(attempt => attempt.notification?.content.includes("marked ready")));
  f.setGraphqlResponse(undefined);
  await f.service.act(f.card.id, action, f.context());
  assert.equal(f.pull.isDraft, false);
  assert.equal(f.pull.state, action === "merge" ? "MERGED" : "OPEN");
});

for (const response of [
  { errors: [{ type: "INTERNAL", message: "Unexpected failure" }] },
  { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_42" } } }, errors: [{ type: "FORBIDDEN" }] },
]) test("ambiguous or partial GraphQL errors retain the ready receipt", async t => {
  const f = fixture(t); f.pull.isDraft = true; f.setGraphqlResponse(response);
  await assert.rejects(f.service.act(f.card.id, "ready", f.context()), /could not verify/);
  assert.ok(f.make().get(f.card.id, f.context()).attempts.some(attempt => attempt.action === "ready"));
  f.setGraphqlResponse(undefined);
  await assert.rejects(f.service.act(f.card.id, "ready", f.context()), /already sent/);
  assert.equal(f.calls.filter(call => (call.body as any)?.query?.startsWith("mutation")).length, 1);
  assert.deepEqual(f.service.pendingNotifications(), []);
});

for (const action of ["ready", "merge"] as const) test(`${action} can make a PR ready again after a completed transition is reverted to draft`, async t => {
  const f = adapterFixture(t); f.pull.isDraft = true;
  await f.service.act(f.card.id, "ready", f.context());
  await f.adapter.notify(f.client, f.card);
  const first = f.card.attempts.find(attempt => attempt.action === "ready")!;
  const originalNotification = structuredClone(first.notification);
  f.pull.isDraft = true; // A maintainer deliberately converts it back on GitHub.
  const restored = f.make(); Object.defineProperty(f.adapter, "actions", { value: restored });
  const card = restored.get(f.card.id, f.context());
  await restored.refresh(card.id, f.context());
  if (action === "merge") await restored.act(card.id, "approve", f.context());
  await restored.act(card.id, action, f.context());
  await f.adapter.notify(f.client, card);
  await restored.act(card.id, action, f.context());
  await f.adapter.notify(f.client, card);
  const attempts = card.attempts.filter(attempt => attempt.action === "ready");
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(attempt => attempt.state === "done"));
  assert.deepEqual(attempts[0].notification, originalNotification);
  assert.notEqual(attempts[0].notification!.id, attempts[1].notification!.id);
  assert.equal(f.sent.filter(message => message.content.includes("marked ready for review")).length, 2);
  assert.equal(f.calls.filter(call => (call.body as any)?.query?.startsWith("mutation")).length, 2);
  assert.equal(f.pull.isDraft, false);
});

for (const action of ["approve", "refresh"] as const) test(`a delayed ${action} handler cannot overwrite a newer revision's shared card`, async t => {
  const f = adapterFixture(t);
  await f.adapter.present(f.client, "session", "guild", "channel");
  t.mock.method(f.adapter.auth, "linked", () => ({ id: 1, login: "ben" }));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.adapter, "notify", async () => { entered(); await gate; });
  const interaction = { client: f.client, user: { id: "ben" }, guildId: "guild", channelId: "channel",
    customId: `gh:${action}:${f.card.id}`, deferReply: async () => {}, isChatInputCommand: () => false,
    editReply: async () => {}, message: { id: "one-message", author: { id: "bot" }, edit: async (value: unknown) => { f.edited.push(value); } } };
  const older = f.adapter.handle(interaction as never);
  await started;
  try {
    f.target.head = merged;
    await f.adapter.present(f.client, "session", "guild", "channel");
    assert.equal(f.edited.length, 1);
    assert.match(f.edited[0].content, /cccccccccccc/);
  } finally { release(); await older; }
  assert.equal(f.edited.length, 1, "the superseded handler must not edit the shared message");
  assert.equal(f.sent.length, 1);
});

test("a new presentation waits for an already-running card edit", async t => {
  const f = adapterFixture(t);
  await f.adapter.present(f.client, "session", "guild", "channel");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const order: string[] = [];
  const older = (f.adapter as any).editCard(f.card, async () => { entered(); await gate; order.push("old"); });
  await started;
  f.target.head = merged;
  const fresh = f.adapter.present(f.client, "session", "guild", "channel").then(() => { order.push("new"); });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(f.edited.length, 0); }
  finally { release(); await Promise.all([older, fresh]); }
  assert.deepEqual(order, ["old", "new"]);
  assert.match(f.edited[0].content, /cccccccccccc/);
});
