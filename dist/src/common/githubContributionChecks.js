import { GitHubActionError, githubJson } from "./githubUserAuth.js";
/** Public CI reads for an owned, host-verified head; never grants Actions writes or exposes credentials. */
export async function readContributionChecks(repository, head, signal, fetcher = fetch) {
    if (!["Rubiss-Projects/ai-assistant", "Rubiss-Projects/docker"].includes(repository) || !/^[a-f0-9]{40}$/.test(head))
        throw new Error("Invalid contribution CI target.");
    const base = `https://api.github.com/repos/${repository}/commits/${head}`;
    const init = { method: "GET", headers: { accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" } };
    try {
        const [runs, statuses] = await Promise.all([
            githubJson(fetcher, `${base}/check-runs?filter=latest&per_page=100`, init, signal),
            githubJson(fetcher, `${base}/status?per_page=100`, init, signal),
        ]);
        if (statuses.sha !== head || runs.check_runs.some(run => run.head_sha !== head))
            throw new Error("CI commit mismatch.");
        const checks = runs.check_runs.map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url,
            summary: [run.output.title, run.output.summary].filter(Boolean).join("\n").slice(0, 4000) }));
        const complete = runs.total_count === checks.length && statuses.total_count === statuses.statuses.length;
        const failed = checks.some(check => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion ?? ""))
            || statuses.statuses.some(status => ["failure", "error"].includes(status.state));
        const pending = checks.some(check => check.status !== "completed") || statuses.statuses.some(status => status.state !== "success");
        const empty = checks.length === 0 && statuses.statuses.length === 0;
        const state = failed ? "failure" : !complete || empty ? "unknown" : pending ? "pending" : "success";
        return { head_sha: head, state, complete, checks, statuses: statuses.statuses };
    }
    catch (error) {
        signal.throwIfAborted();
        return { head_sha: head, state: "unavailable", complete: false, checks: [], statuses: [],
            error: `Could not read public GitHub CI${error instanceof GitHubActionError && error.status ? ` (HTTP ${error.status})` : ""}. Check GitHub or retry later; unavailable CI is not passing.` };
    }
}
