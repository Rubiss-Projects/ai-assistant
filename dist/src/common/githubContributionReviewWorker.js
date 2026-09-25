import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostOnlyGitHubPath, contributionReviewsEnabled } from "./githubContributionConfig.js";
import { REVIEW_LIMIT, REVIEW_TIMEOUT_MS, changedLines, reviewDigest, reviewPath, validateReviewInput, validateReviewResult } from "./codexReviewProtocol.js";
import { ReviewSocketClient, writeReviewState } from "./codexReviewWorker.js";
export { contributionReviewsEnabled } from "./githubContributionConfig.js";
async function snapshot(host, owner, target, id, signal) {
    const request = (role, suffix) => host.request(owner, target.repository, role, "GET", suffix, undefined, signal);
    if (target.changedFiles < 1 || target.changedFiles > 300)
        throw new Error("Review supports at most 300 changed files.");
    // Unlike /pulls/:id/files, this comparison is addressed by immutable commits.
    // GitHub includes at most 300 files on the comparison's first page.
    const comparison = await request("publisher", `/compare/${target.base}...${target.head}?per_page=1`);
    const changed = comparison.files;
    if (changed.length !== target.changedFiles)
        throw new Error("PR file list changed or was truncated.");
    const changes = changed.map(file => {
        if (file.patch === undefined)
            throw new Error("Binary or metadata-only changes cannot be reviewed by this worker.");
        return { path: reviewPath(file.filename), ...(file.previous_filename ? { previousPath: reviewPath(file.previous_filename) } : {}),
            status: file.status, patch: file.patch, additions: file.additions, deletions: file.deletions };
    });
    for (const change of changes)
        changedLines(change);
    const tree = await request("writer", `/git/trees/${target.head}?recursive=1`);
    if (tree.truncated || tree.tree.length > 10_000)
        throw new Error("Repository is too large for a complete review snapshot.");
    const required = new Set(changes.filter(file => file.status !== "removed").map(file => file.path));
    const omitted = [];
    const entries = tree.tree.filter(entry => entry.type !== "tree").sort((a, b) => Number(required.has(b.path)) - Number(required.has(a.path)) || a.path.localeCompare(b.path));
    const files = [];
    let bytes = 0;
    // Sequential API reads are bounded and cancellable; no clone, checkout hooks, or repository code runs on the credential host.
    for (const entry of entries) {
        let supported = ["100644", "100755"].includes(entry.mode) && (entry.size ?? Infinity) <= 1_000_000;
        try {
            reviewPath(entry.path);
        }
        catch {
            supported = false;
        }
        const context = !/^(?:dist|vendor|build)\/|(?:^|\/)(?:package-lock\.json|.*\.lock)$/.test(entry.path);
        if (!supported || (!required.has(entry.path) && (!context || files.length >= 500 || bytes + (entry.size ?? 0) > 8_000_000))) {
            if (required.has(entry.path))
                throw new Error("A changed file cannot be safely included in the review.");
            omitted.push(entry.path);
            continue;
        }
        if (!/^[0-9a-f]{40}$/.test(entry.sha))
            throw new Error("Invalid source blob.");
        const blob = await request("writer", `/git/blobs/${entry.sha}`);
        if (blob.encoding !== "base64" || blob.size > 1_000_000)
            throw new Error("Unsupported review source encoding.");
        const data = Buffer.from(blob.content, "base64");
        if (createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") !== entry.sha)
            throw new Error("Review source hash mismatch.");
        let content;
        try {
            if (data.includes(0))
                throw new Error();
            content = new TextDecoder("utf-8", { fatal: true }).decode(data);
        }
        catch {
            if (required.has(entry.path))
                throw new Error("Binary changed files cannot be reviewed.");
            omitted.push(entry.path);
            continue;
        }
        bytes += data.length;
        files.push({ path: entry.path, content });
    }
    const current = await host.target(owner, signal);
    if (current.head !== target.head || current.base !== target.base)
        throw new Error("PR changed during snapshot preparation.");
    return validateReviewInput({ id, repository: target.repository.upstream, pull: target.pull, head: target.head, base: target.base, files, changes, omitted });
}
/** Only this host controller publishes; the separate Codex worker never gets GitHub credentials. */
export class ContributionReviewWorker {
    stateFile;
    host;
    transport;
    attempts;
    timer;
    active;
    abort = new AbortController();
    constructor(stateFile, host, transport = new ReviewSocketClient()) {
        this.stateFile = stateFile;
        this.host = host;
        this.transport = transport;
        hostOnlyGitHubPath(stateFile);
        this.attempts = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : [];
        if (!Array.isArray(this.attempts) || this.attempts.length > 5000 || this.attempts.some(item => !item?.id || !item.requester?.userId || !["queued", "submitted", "publishing", "completed", "failed", "stale"].includes(item.state)))
            throw new Error("Invalid contribution review state.");
    }
    save() { hostOnlyGitHubPath(this.stateFile); writeReviewState(this.stateFile, this.attempts); }
    enqueue(owner, target) {
        const previous = this.attempts.find(item => item.repository === target.repository.upstream && item.pull === target.pull && item.head === target.head && item.base === target.base);
        if (previous)
            return this.status(owner.contribution);
        if (this.attempts.filter(item => item.repository === target.repository.upstream && item.pull === target.pull).length >= REVIEW_LIMIT || this.attempts.length >= 5000)
            return this.status(owner.contribution);
        this.attempts.push({ ...owner, id: randomUUID(), repository: target.repository.upstream, pull: target.pull, head: target.head, base: target.base,
            state: "queued", createdAt: Date.now(), failures: 0, nextPoll: 0 });
        this.save();
        return this.status(owner.contribution);
    }
    status(contribution) {
        const attempts = this.attempts.filter(item => item.contribution === contribution);
        const last = attempts.at(-1);
        return { enabled: true, attempts: attempts.length, limit: REVIEW_LIMIT, budget_exhausted: attempts.length >= REVIEW_LIMIT,
            state: last?.state ?? "not_requested", head_sha: last?.head, base_sha: last?.base, result: last?.result, error: last?.error, review_url: last?.url };
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => { if (!this.active) {
            this.active = this.tick().catch(() => console.error("[codex-review] Controller failed; inspect protected review state.")).finally(() => { this.active = undefined; });
        } }, 2000);
        this.timer.unref();
    }
    async close() { clearInterval(this.timer); this.timer = undefined; this.abort.abort(); await this.active; }
    async tick() {
        if (!contributionReviewsEnabled() || this.abort.signal.aborted)
            return;
        // Keep one slot globally, including remote inference between polls. Later PRs must not fail just because the worker is busy.
        const item = this.attempts.find(attempt => ["queued", "submitted", "publishing"].includes(attempt.state));
        if (!item || item.nextPoll > Date.now())
            return;
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(5 * 60_000)]);
        try {
            item.startedAt ??= Date.now(); // Queue wait never consumes the execution/recovery deadline.
            if (Date.now() - item.startedAt > REVIEW_TIMEOUT_MS + 15 * 60_000)
                throw new Error("Review job expired.");
            let job = await this.transport.get(item.id, signal);
            if (!job) {
                if (item.state !== "queued")
                    throw new Error("Worker lost the review receipt; do not retry automatically.");
                const target = await this.host.target(item, signal);
                if (target.repository.upstream !== item.repository || target.pull !== item.pull || target.head !== item.head || target.base !== item.base) {
                    item.state = "stale";
                    item.error = "PR head or base changed; no current-head review was published.";
                    this.save();
                    return;
                }
                const input = await snapshot(this.host, item, target, item.id, signal);
                item.digest = reviewDigest(input);
                item.changes = input.changes;
                this.save();
                job = await this.transport.submit(input, signal);
            }
            if (job.id !== item.id || job.digest !== item.digest || job.head !== item.head || job.base !== item.base || job.repository !== item.repository || job.pull !== item.pull)
                throw new Error("Review worker returned a mismatched receipt.");
            if (job.state === "failed") {
                item.state = "failed";
                item.error = job.error;
                this.save();
                return;
            }
            if (job.state !== "completed") {
                item.state = "submitted";
                item.nextPoll = Date.now() + 5000;
                this.save();
                return;
            }
            if (!item.changes)
                throw new Error("Review snapshot receipt is missing.");
            item.result = validateReviewResult(job.result, { changes: item.changes });
            // Recheck live authorization and PR identity immediately before publication.
            const target = await this.host.target(item, signal);
            if (target.repository.upstream !== item.repository || target.pull !== item.pull || target.head !== item.head || target.base !== item.base) {
                item.state = "stale";
                this.save();
                return;
            }
            const marker = `<!-- ai-assistant-codex-review:${item.id} -->`;
            const request = (method, suffix, body) => this.host.request(item, target.repository, "publisher", method, suffix, body, signal);
            let previous;
            for (let page = 1; page <= 10; page++) {
                const reviews = await request("GET", `/pulls/${item.pull}/reviews?per_page=100&page=${page}`);
                previous = reviews.find(review => review.body.includes(marker) && review.commit_id === item.head);
                if (previous || reviews.length < 100)
                    break;
                if (page === 10)
                    throw new Error("Review history exceeds the publication limit.");
            }
            if (previous) {
                item.url = previous.html_url;
                item.state = "completed";
                this.save();
                return;
            }
            if (item.state === "publishing")
                throw new Error("GitHub publication outcome is uncertain; refusing a duplicate review.");
            const safeText = (text) => text.replace(/@/g, "＠"); // Generated text cannot trigger account mentions or commands.
            const findings = item.result.findings.map(finding => `- [P${finding.priority}] ${safeText(finding.title)} — \`${finding.path}:${finding.line}\`\n\n  ${safeText(finding.body)}`).join("\n\n");
            const body = `## Codex-powered static review\n\n${safeText(item.result.summary)}\n\n${findings || "No actionable findings in this static review."}\n\nHead: \`${item.head}\`; base: \`${item.base}\`. Reviewed in a fresh, read-only server-side Codex session using the operator's ChatGPT login. Published by AI Assistant, not the hosted Codex GitHub integration. No tests or repository code were executed. This is not approval; human review remains required.\n\n${marker}`;
            const comments = item.result.findings.filter(finding => item.changes?.some(change => change.path === finding.path && changedLines(change).has(finding.line)))
                .map(finding => ({ path: finding.path, line: finding.line, side: "RIGHT", body: `[P${finding.priority}] ${safeText(finding.title)}\n\n${safeText(finding.body)}` }));
            item.state = "publishing";
            this.save();
            const published = await request("POST", `/pulls/${item.pull}/reviews`, { commit_id: item.head, event: "COMMENT", body, ...(comments.length ? { comments } : {}) });
            item.url = published.html_url;
            item.state = "completed";
            this.save();
            console.info(`[codex-review] published repository=${item.repository} pr=${item.pull} head=${item.head} findings=${item.result.findings.length}`);
        }
        catch {
            if (this.abort.signal.aborted)
                return;
            item.failures++;
            item.nextPoll = Date.now() + 30_000;
            if (item.failures >= 3) {
                item.state = "failed";
                item.error = "Review could not be completed or publication is uncertain. No clean review is claimed. Operator investigation required.";
            }
            this.save();
            console.warn(`[codex-review] operation failed job=${item.id} attempt=${item.failures} state=${item.state}`);
        }
    }
}
