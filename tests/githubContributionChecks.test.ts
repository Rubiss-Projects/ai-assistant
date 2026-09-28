import assert from "node:assert/strict";
import test from "node:test";
import { readContributionChecks } from "../src/common/githubContributionChecks.js";

const repository = "Rubiss-Projects/ai-assistant", head = "a".repeat(40);

test("public CI reads combine current checks and statuses without credentials", async () => {
  const check = { name: "build", head_sha: head, status: "completed", conclusion: "success", html_url: "https://github.com/check/1", output: { title: "Build", summary: "Passed" } };
  const runs = { total_count: 2, check_runs: [check, { ...check, name: "container-runtime" }] };
  const statuses = { sha: head, total_count: 0, statuses: [] as { context: string; state: string; target_url: string; description: string }[] };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.ok(String(url).startsWith(`https://api.github.com/repos/${repository}/commits/${head}/`));
    return Response.json(String(url).includes("check-runs?") ? runs : statuses);
  };
  const read = () => readContributionChecks(repository, head, AbortSignal.timeout(1000), fetcher);
  assert.equal((await read()).state, "success");
  for (const conclusion of ["neutral", "skipped"]) {
    for (const run of runs.check_runs) run.conclusion = conclusion;
    assert.equal((await read()).state, "success");
  }
  check.conclusion = "success";
  statuses.statuses.push({ context: "external", state: "pending", target_url: "https://example.com/check", description: "Running" }); statuses.total_count = 1;
  assert.equal((await read()).state, "pending");
  statuses.statuses[0].state = "failure";
  assert.equal((await read()).state, "failure");
  statuses.statuses[0].state = "success"; check.status = "in_progress";
  assert.equal((await read()).state, "pending");
  check.status = "completed"; check.conclusion = "failure";
  assert.equal((await read()).state, "failure");
  check.conclusion = "success"; runs.total_count = 101;
  assert.equal((await read()).state, "unknown");
  runs.total_count = 2; check.head_sha = "b".repeat(40);
  assert.equal((await read()).state, "unavailable");
  runs.check_runs = []; runs.total_count = 0; statuses.statuses = []; statuses.total_count = 0;
  assert.equal((await read()).state, "unknown");
});

test("CI cannot pass before the supported repository's expected jobs register", async () => {
  for (const [repository, expected] of [
    ["Rubiss-Projects/ai-assistant", ["build", "container-runtime"]],
    ["Rubiss-Projects/docker", ["Repository validation"]],
  ] as const) {
    const skipped = { name: "dependabot", head_sha: head, status: "completed", conclusion: "skipped", html_url: "", output: { title: null, summary: null } };
    const runs = { total_count: 1, check_runs: [skipped] };
    const fetcher: typeof fetch = async url => Response.json(String(url).includes("check-runs?") ? runs : { sha: head, total_count: 0, statuses: [] });
    const read = () => readContributionChecks(repository, head, AbortSignal.timeout(1000), fetcher);
    for (const [index, name] of expected.entries()) {
      const result = await read();
      assert.equal(result.state, "unknown");
      assert.deepEqual(result.missing_checks, expected.slice(index));
      runs.check_runs.push({ ...skipped, name, conclusion: "success" });
      runs.total_count++;
    }
    assert.equal((await read()).state, "success");
  }
});

test("CI rate limits and cancellation cannot be reported as passing", async () => {
  const result = await readContributionChecks(repository, head, AbortSignal.timeout(1000), async () => new Response("secret error body", { status: 403 }));
  assert.equal(result.state, "unavailable"); assert.equal(result.complete, false);
  assert.match(result.error!, /HTTP 403/); assert.ok(!result.error!.includes("secret"));
  const signal = AbortSignal.abort();
  await assert.rejects(readContributionChecks(repository, head, signal, async () => { signal.throwIfAborted(); throw new Error(); }));
});
