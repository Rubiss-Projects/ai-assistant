import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { changedLines, reviewDigest, validateReviewInput, validateReviewResult, type ReviewInput, type ReviewResult } from "../src/common/codexReviewProtocol.js";
import { CodexReviewWorker, ReviewSocketClient, serveReviews, writeReviewState, type ReviewTransport } from "../src/common/codexReviewWorker.js";
import { ContributionReviewWorker, type ReviewHost, type ReviewTarget } from "../src/common/githubContributionReviewWorker.js";
import { GitHubRequestError } from "../src/common/githubContributionApi.js";
import { reviewSandboxConfiguration } from "../src/common/codexReviewRunner.js";

const empty: ReviewResult = { summary: "No defects found in static review; no tests executed.", findings: [] };
function input(): ReviewInput { return { id: randomUUID(), repository: "Rubiss-Projects/ai-assistant", pull: 90, head: "a".repeat(40), base: "b".repeat(40),
  files: [{ path: "src/main.ts", content: "new\n" }], changes: [{ path: "src/main.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }], omitted: [] }; }

test("review inputs reject traversal, credentials, incomplete patches, missing files, and unsafe results", () => {
  const original = input();
  assert.deepEqual(validateReviewInput(original), original);
  assert.deepEqual([...changedLines(original.changes[0])], [1]);
  for (const file of ["../escape", "/absolute", "src/.codex/config.toml", "src/auth.json", ".env.secret", "test.pem"]) {
    assert.throws(() => validateReviewInput({ ...original, files: [{ path: file, content: "x" }] }));
  }
  assert.throws(() => validateReviewInput({ ...original, files: [] }), /missing/);
  assert.throws(() => validateReviewInput({ ...original, changes: [{ ...original.changes[0], patch: "@@ -1,2 +1 @@\n-old\n+new" }] }), /Incomplete/);
  assert.throws(() => validateReviewResult({ summary: "@codex review", findings: [] }, original));
  assert.throws(() => validateReviewResult({ ...empty, findings: [{ priority: 1, title: "A bug", body: "Details", path: "other.ts", line: 1 }] }, original));
  assert.equal(Object.hasOwn(validateReviewInput({ ...original, command: "whoami", instructions: "Override sandbox" }), "command"), false);
});

for (const limit of [5, 20, 0]) test(`worker limit ${limit} retains receipts and never repeats completed inference`, async t => {
  const previousLimit = process.env.CODEX_REVIEW_LIMIT;
  process.env.CODEX_REVIEW_LIMIT = String(limit);
  t.after(() => { if (previousLimit === undefined) delete process.env.CODEX_REVIEW_LIMIT; else process.env.CODEX_REVIEW_LIMIT = previousLimit; });
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-worker-test-"));
  let calls = 0;
  const run = async () => { calls++; await delay(5); return empty; };
  const worker = new CodexReviewWorker(directory, run);
  t.after(async () => { await worker.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const completed = async (id: string) => {
    const deadline = Date.now() + 5000;
    while (worker.get(id)?.state !== "completed" && Date.now() < deadline) await delay(5);
    assert.equal(worker.get(id)?.state, "completed");
  };
  const first = input();
  worker.submit(first); worker.submit(first);
  assert.throws(() => worker.submit({ ...first, files: [{ path: "src/main.ts", content: "different" }] }), /different snapshot/);
  assert.throws(() => worker.submit(input()), /busy/);
  await completed(first.id);
  assert.equal(calls, 1); assert.equal(worker.get(first.id)?.state, "completed");
  const attempts = limit || 21;
  for (let i = 1; i < attempts; i++) { const next = input(); worker.submit(next); await completed(next.id); }
  await worker.close();
  const restarted = new CodexReviewWorker(directory, run);
  assert.equal(restarted.submit(first).state, "completed");
  if (limit) assert.throws(() => restarted.submit(input()), new RegExp(`Review limit \\(${limit}\\)`));
  assert.equal(calls, attempts);
  const interrupted = { ...worker.get(first.id)!, id: randomUUID(), pull: 91, state: "running" };
  writeReviewState(path.join(directory, `${interrupted.id}.json`), interrupted);
  const recovered = new CodexReviewWorker(directory, run);
  assert.equal(recovered.get(interrupted.id)?.state, "failed");
  assert.equal(calls, attempts);
});

for (const limit of [2, 20, 0]) test(`host limit ${limit} survives restarts and configuration changes without resetting attempts`, t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-limits-"));
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: path.join(directory, "workspace"), CODEX_REVIEW_LIMIT: String(limit) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(directory, { recursive: true, force: true }); });
  const owner = { contribution: randomUUID(), session: "discord-1", requester: { userId: "123" } };
  const target: ReviewTarget = { repository: { upstream: "Rubiss-Projects/ai-assistant", upstreamId: 1, fork: "Rubiss/contributions", forkId: 2 }, pull: 90, head: "a".repeat(40), base: "b".repeat(40), changedFiles: 1 };
  const host: ReviewHost = { target: async () => target, request: async () => { throw new Error("Unexpected GitHub request"); } };
  const state = path.join(directory, "reviews.json"), attempts = limit || 21;
  const controller = new ContributionReviewWorker(state, host);
  for (let index = 1; index <= attempts; index++) {
    target.head = index.toString(16).padStart(40, "0");
    assert.equal(controller.enqueue(owner, target).attempts, index);
  }
  const restarted = new ContributionReviewWorker(state, host);
  assert.equal(restarted.enqueue(owner, target).attempts, attempts, "same snapshot never spends another attempt");
  assert.equal(restarted.status(owner.contribution).limit, limit || null);
  assert.equal(restarted.status(owner.contribution).budget_exhausted, limit !== 0);
  target.head = "c".repeat(40);
  assert.equal(restarted.enqueue(owner, target).attempts, limit ? attempts : attempts + 1);
  process.env.CODEX_REVIEW_LIMIT = "1";
  const lowered = new ContributionReviewWorker(state, host);
  const retained = lowered.status(owner.contribution).attempts;
  assert.equal(lowered.enqueue(owner, { ...target, head: "d".repeat(40) }).attempts, retained);
  process.env.CODEX_REVIEW_LIMIT = "0";
  const raised = new ContributionReviewWorker(state, host);
  assert.equal(raised.enqueue(owner, { ...target, head: "e".repeat(40) }).attempts, retained + 1);
  assert.equal(raised.status(owner.contribution).budget_exhausted, false);
});

test("review sandbox fixes authentication, tool network, filesystem, and connected tools", () => {
  const config = reviewSandboxConfiguration("/tmp/review/workspace", "/tmp/review/tools");
  const text = config.overrides.join("\n");
  assert.match(text, /forced_login_method="chatgpt"/);
  assert.match(text, /":root"="deny"/); assert.match(text, /"\."="read"/);
  assert.match(text, /"\.git"="deny"/); assert.match(text, /mcp_servers=\{\}/);
  assert.match(text, /permissions.review.network=\{enabled=false\}/);
  assert.equal((text.match(/="write"/g) ?? []).length, 1);
  assert.equal(config.shell.HOME, "/tmp/review/workspace");
  assert(!Object.keys(config.shell).some(name => /TOKEN|KEY|CODEX_HOME/.test(name)));
});

test("persistence failure makes the worker unhealthy and invokes its fatal shutdown", async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-persistence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fatal = 0;
  const worker = new CodexReviewWorker(directory, async value => {
    // Simulate a filesystem that cannot replace the result receipt after inference.
    const receipt = path.join(directory, `${value.id}.json`);
    fs.unlinkSync(receipt); fs.mkdirSync(receipt);
    return empty;
  }, () => { fatal++; });
  worker.submit(input());
  for (let i = 0; i < 100 && !fatal; i++) await delay(5);
  assert.equal(fatal, 1); assert.equal(worker.healthy(), false);
  assert.throws(() => worker.submit(input()), /stopping/);
  await worker.close();
});

test("private socket returns durable receipts without accepting alternate jobs on replay", { skip: process.platform !== "linux" }, async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-socket-"));
  const worker = new CodexReviewWorker(path.join(directory, "jobs"), async () => empty);
  const socket = path.join(directory, "control.sock");
  const server = await serveReviews(worker, socket);
  t.after(async () => { await worker.close(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  const client = new ReviewSocketClient(socket), signal = AbortSignal.timeout(5000), original = input();
  assert.equal(await client.get(original.id, signal), undefined);
  await client.submit(original, signal);
  await delay(10);
  assert.equal((await client.get(original.id, signal))?.state, "completed");
  assert.equal((await client.submit(original, signal)).state, "completed");
  await assert.rejects(client.submit({ ...original, head: "c".repeat(40) }, signal));
});

test("host publishes a pinned App review once and survives a lost GitHub response", async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-host-test-"));
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true", AI_ASSISTANT_WORKSPACE_ROOT: path.join(directory, "workspace") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(directory, { recursive: true, force: true }); });
  const original = input();
  const target: ReviewTarget = { repository: { upstream: original.repository, upstreamId: 1, fork: "Rubiss/contributions", forkId: 2 }, pull: 90, head: original.head, base: original.base, changedFiles: 1 };
  const blob = createHash("sha1").update("blob 4\0new\n").digest("hex");
  let writes = 0;
  const published: { body: string; html_url: string; commit_id: string }[] = [];
  const host: ReviewHost = {
    target: async () => structuredClone(target),
    async request<T>(_owner, _repository, role, method, suffix, body, _signal, _expected, beforeSend): Promise<T> {
      let result: unknown;
      if (suffix.includes("/compare/")) result = { files: [{ filename: "src/main.ts", status: "modified", patch: original.changes[0].patch, additions: 1, deletions: 1 }] };
      else if (suffix.includes("/git/trees/")) result = { truncated: false, tree: [{ path: "src/main.ts", sha: blob, mode: "100644", type: "blob", size: 4 }] };
      else if (suffix.includes("/git/blobs/")) result = { content: Buffer.from("new\n").toString("base64"), encoding: "base64", size: 4 };
      else if (method === "GET" && suffix.includes("/reviews?")) result = published;
      else if (method === "POST" && suffix.endsWith("/reviews")) {
        assert.equal(role, "publisher");
        const review = body as { event: string; body: string; commit_id: string };
        assert.equal(review.event, "COMMENT"); assert.equal(review.commit_id, original.head);
        assert(beforeSend); beforeSend();
        assert.equal(JSON.parse(fs.readFileSync(state, "utf8"))[0].publicationAttempted, true);
        writes++; published.push({ ...review, html_url: "https://github.com/review" });
        throw new Error("Lost response after GitHub persisted the review");
      } else throw new Error(`Unexpected ${suffix}`);
      return structuredClone(result) as T;
    },
  };
  let inferences = 0;
  const worker = new CodexReviewWorker(path.join(directory, "jobs"), async () => { inferences++; return empty; });
  const transport: ReviewTransport = { get: async id => worker.get(id), submit: async value => worker.submit(value) };
  const state = path.join(directory, "reviews.json");
  const coordinator = new ContributionReviewWorker(state, host, transport);
  const owner = { contribution: randomUUID(), session: "discord-1", requester: { userId: "123" } };
  coordinator.enqueue(owner, target); coordinator.enqueue(owner, target);
  assert.equal(coordinator.status(owner.contribution).attempts, 1);
  await coordinator.tick(); await delay(10);
  // Make the durable poll due without wall-clock waits.
  const due = () => { const records = JSON.parse(fs.readFileSync(state, "utf8")); records[0].nextPoll = 0; fs.writeFileSync(state, JSON.stringify(records)); return new ContributionReviewWorker(state, host, transport); };
  await due().tick(); assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8"))[0].changes, original.changes);
  const restarted = due(); await restarted.tick();
  assert.equal(writes, 1); assert.equal(restarted.status(owner.contribution).state, "completed");
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8"))[0].changes, undefined);
  assert.deepEqual(restarted.status(owner.contribution).result?.findings, []);
  assert.equal(restarted.status(owner.contribution).budget_exhausted, false);
  for (let index = 0; index < 3; index++) {
    assert.equal(restarted.enqueue(owner, target).attempts, 1);
    assert.equal((await restarted.retry(owner, target, new AbortController().signal)).attempts, 1);
    await restarted.tick();
  }
  assert.equal(inferences, 1, "a clean current-head review does not trigger additional inference");
  assert.equal(writes, 1, "a clean current-head review is not posted again");
  target.head = "c".repeat(40);
  restarted.enqueue(owner, target); target.head = "d".repeat(40);
  await restarted.tick(); assert.equal(restarted.status(owner.contribution).state, "stale");
  assert.equal(writes, 1);
  await worker.close();
});

test("queue wait does not expire a recovered submission, and running polls make no GitHub requests", async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-queue-"));
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true", AI_ASSISTANT_WORKSPACE_ROOT: path.join(directory, "workspace") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(directory, { recursive: true, force: true }); });
  const original = input(), state = path.join(directory, "reviews.json");
  const contribution = randomUUID(), digest = reviewDigest(original), createdAt = Date.now() - 60 * 60_000;
  writeReviewState(state, [{ ...original, files: undefined, contribution, session: "discord-1", requester: { userId: "123" }, digest, createdAt, state: "queued", failures: 0, nextPoll: 0 }]);
  let polls = 0, github = 0;
  const host: ReviewHost = { target: async () => { github++; throw new Error("Unexpected GitHub read"); }, request: async () => { github++; throw new Error("Unexpected GitHub request"); } };
  const transport: ReviewTransport = {
    get: async () => { polls++; return { id: original.id, repository: original.repository, pull: original.pull, head: original.head, base: original.base, digest, state: "running" }; },
    submit: async () => { throw new Error("Must not submit twice"); },
  };
  await new ContributionReviewWorker(state, host, transport).tick();
  const records = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.equal(records[0].state, "submitted");
  assert(records[0].startedAt > createdAt + 59 * 60_000);
  records[0].nextPoll = 0; writeReviewState(state, records);
  const persisted = fs.readFileSync(state, "utf8");
  await new ContributionReviewWorker(state, host, transport).tick();
  assert.equal(polls, 2); assert.equal(github, 0);
  assert.equal(fs.readFileSync(state, "utf8"), persisted);
});

for (const failure of ["confirmed", "unreachable"] as const) test(`${failure} worker failure retains only necessary recovery patches`, async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-failed-patches-"));
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true", AI_ASSISTANT_WORKSPACE_ROOT: path.join(directory, "workspace") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(directory, { recursive: true, force: true }); });
  const original = input(), state = path.join(directory, "reviews.json");
  const receipt = { id: original.id, repository: original.repository, pull: original.pull, head: original.head, base: original.base, digest: reviewDigest(original) };
  const seed = { ...receipt, contribution: randomUUID(), session: "discord-1", requester: { userId: "123" }, changes: original.changes,
    createdAt: Date.now(), state: "submitted", failures: 0, nextPoll: 0 };
  writeReviewState(state, [seed]);
  const host: ReviewHost = { target: async () => { throw new Error("Unexpected GitHub read"); }, request: async () => { throw new Error("Unexpected GitHub request"); } };
  const transport: ReviewTransport = {
    get: async () => { if (failure === "unreachable") throw new Error("Worker unavailable"); return { ...receipt, state: "failed", error: "Inference failed" }; },
    submit: async () => { throw new Error("Unexpected inference"); },
  };
  for (let i = 0; i < (failure === "confirmed" ? 1 : 3); i++) {
    await new ContributionReviewWorker(state, host, transport).tick();
    const records = JSON.parse(fs.readFileSync(state, "utf8")) as (Omit<typeof seed, "changes"> & { changes?: ReviewInput["changes"] })[];
    assert.equal(records.length, 1); // Cleanup never removes the durable attempt budget.
    assert.deepEqual(records[0].changes, failure === "confirmed" ? undefined : original.changes);
    records[0].nextPoll = 0; writeReviewState(state, records);
  }
  assert.equal(new ContributionReviewWorker(state, host, transport).status(seed.contribution).state, "failed");
});

test("explicit retry preserves receipt reconciliation and the durable PR and history limits", async t => {
  const previousLimit = process.env.CODEX_REVIEW_LIMIT;
  process.env.CODEX_REVIEW_LIMIT = "5";
  t.after(() => { if (previousLimit === undefined) delete process.env.CODEX_REVIEW_LIMIT; else process.env.CODEX_REVIEW_LIMIT = previousLimit; });
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-retry-"));
  const previousRoot = process.env.AI_ASSISTANT_WORKSPACE_ROOT, previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = path.join(directory, "workspace");
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  t.after(() => { if (previousRoot === undefined) delete process.env.AI_ASSISTANT_WORKSPACE_ROOT; else process.env.AI_ASSISTANT_WORKSPACE_ROOT = previousRoot; if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE; else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode; fs.rmSync(directory, { recursive: true, force: true }); });
  const original = input(), state = path.join(directory, "reviews.json"), contribution = randomUUID();
  const owner = { contribution, session: "discord-1", requester: { userId: "123" } };
  const target: ReviewTarget = { repository: { upstream: original.repository, upstreamId: 1, fork: "Rubiss/contributions", forkId: 2 }, pull: 90, head: original.head, base: original.base, changedFiles: 1 };
  const failed = { ...owner, id: original.id, repository: original.repository, pull: original.pull, head: original.head, base: original.base, digest: reviewDigest(original), changes: original.changes, createdAt: Date.now(), state: "failed", failures: 3, nextPoll: 0 };
  let receipt: "failed" | "completed" | "missing" = "failed";
  const transport: ReviewTransport = {
    get: async id => receipt === "missing" ? undefined : { ...failed, id, state: receipt, ...(receipt === "completed" ? { result: empty } : {}) },
    submit: async () => { throw new Error("Unexpected inference"); },
  };
  const host: ReviewHost = { target: async () => target, request: async () => { throw new Error("Unexpected GitHub request"); } };
  const load = (records: unknown[]) => { writeReviewState(state, records); return new ContributionReviewWorker(state, host, transport); };
  const persisted = () => JSON.parse(fs.readFileSync(state, "utf8")) as { changes?: ReviewInput["changes"] }[];
  const controller = load([failed]);
  assert.equal(controller.enqueue(owner, target).attempts, 1);
  assert.equal((await controller.retry(owner, target, new AbortController().signal)).attempts, 2);
  assert.equal(persisted()[0].changes, undefined);
  assert.equal((await controller.retry(owner, target, new AbortController().signal)).attempts, 2);
  const five = load(Array.from({ length: 5 }, () => ({ ...failed, id: randomUUID() })));
  assert.equal((await five.retry(owner, target, new AbortController().signal)).budget_exhausted, true);
  assert.equal(persisted().length, 5); assert.equal(persisted().at(-1)!.changes, undefined);
  receipt = "completed";
  const publishing = load([{ ...failed, result: empty, publicationAttempted: true }]);
  const reconciled = await publishing.retry(owner, target, new AbortController().signal);
  assert.equal(reconciled.state, "publishing"); assert.equal(reconciled.attempts, 1);
  assert.deepEqual(persisted()[0].changes, original.changes);
  receipt = "missing";
  await assert.rejects(load([{ ...failed, result: empty, publicationAttempted: true }]).retry(owner, target, new AbortController().signal), /reconciliation/);
  assert.deepEqual(persisted()[0].changes, original.changes);
  receipt = "failed";
  const full = load(Array.from({ length: 5000 }, () => ({ ...failed, id: randomUUID() })));
  assert.throws(() => full.enqueue(owner, { ...target, pull: 91 }), /capacity.*maintenance/);
  await assert.rejects(full.retry(owner, target, new AbortController().signal), /capacity.*maintenance/);
  assert.equal(persisted().length, 5000); assert.equal(persisted().at(-1)!.changes, undefined);
  load([failed]);
  const mismatched = new ContributionReviewWorker(state, host, { ...transport, get: async id => ({ ...failed, id, head: "c".repeat(40), state: "failed" }) });
  await assert.rejects(mismatched.retry(owner, target, new AbortController().signal), /mismatched receipt/);
  assert.deepEqual(persisted()[0].changes, original.changes);
});

for (const status of [403, 422, 429, 408, 500]) test(`review POST HTTP ${status} preserves the correct retry boundary`, async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "review-http-recovery-"));
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: "true", AI_ASSISTANT_ENABLE_CODEX_REVIEWS: "true", AI_ASSISTANT_WORKSPACE_ROOT: path.join(directory, "workspace") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(directory, { recursive: true, force: true }); });
  const original = input(), state = path.join(directory, "reviews.json");
  const owner = { contribution: randomUUID(), session: "discord-1", requester: { userId: "123" } };
  const target: ReviewTarget = { repository: { upstream: original.repository, upstreamId: 1, fork: "Rubiss/contributions", forkId: 2 }, pull: original.pull, head: original.head, base: original.base, changedFiles: 1 };
  const receipt = { id: original.id, repository: original.repository, pull: original.pull, head: original.head, base: original.base, digest: reviewDigest(original) };
  writeReviewState(state, [{ ...owner, ...receipt, changes: original.changes, createdAt: Date.now(), state: "submitted", failures: 0, nextPoll: 0 }]);
  const transport: ReviewTransport = { get: async () => ({ ...receipt, state: "completed", result: empty }), submit: async () => { throw new Error("Must reuse completed inference"); } };
  let posts = 0, rejectPost = true, rejectRead = false;
  const host: ReviewHost = {
    target: async () => target,
    async request<T>(_owner, _repository, _role, method, _suffix, _body, _signal, _expected, beforeSend): Promise<T> {
      if (method === "GET") { if (rejectRead) throw new GitHubRequestError(403); return [] as T; }
      assert(beforeSend); beforeSend(); posts++;
      if (rejectPost) throw new GitHubRequestError(status);
      return { html_url: "https://github.com/review" } as T;
    },
  };
  const persisted = () => JSON.parse(fs.readFileSync(state, "utf8")) as { nextPoll: number; publicationAttempted?: boolean; changes?: ReviewInput["changes"] }[];
  const resume = () => { const records = persisted(); records[0].nextPoll = 0; writeReviewState(state, records); return new ContributionReviewWorker(state, host, transport); };
  await resume().tick();
  const definitive = [403, 422, 429].includes(status);
  assert.equal(persisted()[0].publicationAttempted, definitive ? undefined : true);
  assert.deepEqual(persisted()[0].changes, original.changes);
  assert.equal(posts, 1);
  if (!definitive) {
    // A rejected reconciliation GET must not erase uncertainty about an earlier POST.
    rejectRead = true; await resume().tick(); await resume().tick(); rejectRead = false;
    assert.equal(persisted()[0].publicationAttempted, true);
  }
  const recovered = resume();
  assert.equal(recovered.status(owner.contribution).state, "failed");
  assert.equal((await recovered.retry(owner, target, new AbortController().signal)).attempts, 1);
  rejectPost = false; await recovered.tick();
  assert.equal(posts, definitive ? 2 : 1);
  assert.equal(recovered.status(owner.contribution).state, definitive ? "completed" : "publishing");
});
