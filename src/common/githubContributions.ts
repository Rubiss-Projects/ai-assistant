import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAccessPolicy, type AccessPolicy, type AccessSubject } from "./accessPolicy.js";
import { setTimeout as delay } from "node:timers/promises";
import type { ReviewTransport } from "./codexReviewWorker.js";
import { ContributionReviewWorker, contributionReviewsEnabled, type ReviewOwner, type ReviewTarget } from "./githubContributionReviewWorker.js";
import { GitHubContributionApi, GitHubRequestError, type ContributionApi, type GitHubRole } from "./githubContributionApi.js";
import { githubContributionsEnabled, hostOnlyGitHubPath, loadGitHubContributionConfiguration, type ContributionRepository, type GitHubContributionConfiguration } from "./githubContributionConfig.js";
import { REVIEW_THREADS_QUERY, REVIEW_THREAD_QUERY, REPLY_REVIEW_THREAD, RESOLVE_REVIEW_THREAD, isPublisherComment, reviewThreadSummary, reviewThreadVersion, type ReviewThread } from "./githubContributionReviews.js";

export interface ContributionCaller { session: string; requester: AccessSubject; access: AccessPolicy; signal: AbortSignal }
interface Contribution {
  id: string; session: string; user: string; guild: string | null; repository: string;
  branch: string; baseBranch: string; baseSha: string; headSha: string; pull?: number;
  pendingSha?: string; published: boolean; closed: boolean; createdAt: number;
}
interface RepositoryMetadata { id: number; full_name: string; private: boolean; archived: boolean; fork: boolean; parent?: { id: number }; default_branch: string }
interface GitEntry { path: string; sha: string; mode: string; type: string; size?: number }
interface GitTree { sha: string; tree: GitEntry[]; truncated: boolean }
interface PullRequest {
  number: number; html_url: string; state: string; draft: boolean; merged: boolean;
  user: { login: string }; head: { ref: string; sha: string; repo: { id: number } | null };
  base: { ref: string; sha: string; repo: { id: number } }; changed_files: number;
}
export interface ContributionChange { path: string; content: string | null }
function rejectCredentials(text: string): void {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/.test(text)) throw new Error("Potential credentials detected; remove them before publishing.");
}

function sha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("GitHub returned an invalid commit identifier.");
  return value;
}

export function validateContributionPath(value: unknown, writable = false): string {
  if (typeof value !== "string" || value.length > 240 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split("/").some(segment => !segment || segment === "." || segment === "..")) throw new Error("Use a relative repository file path without traversal.");
  const segments = value.toLowerCase().split("/");
  if (segments.includes(".git") || segments.includes("node_modules") || segments.includes(".ssh") || segments.includes(".codex")
    || segments.some(segment => segment === ".env" || (segment.startsWith(".env.") && segment !== ".env.example"))
    || /(?:^|\/)(?:auth\.json|\.netrc|\.npmrc|\.git-credentials)$|\.(?:pem|key|p12|pfx)$/i.test(value)
    || (writable && segments.some(segment => segment === ".github" || segment === ".gitmodules"))) {
    throw new Error("Credential paths and GitHub automation files cannot be contributed through this tool.");
  }
  return value;
}

export function validateContributionChanges(value: unknown): ContributionChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new Error("Publish between 1 and 30 text-file changes.");
  let bytes = 0;
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid file change.");
    const change = raw as Record<string, unknown>;
    if (Object.keys(change).some(key => !["path", "content"].includes(key))) throw new Error("Only path and content are accepted for file changes.");
    const file = validateContributionPath(change.path, true);
    if ([...seen].some(other => other === file.toLowerCase() || other.startsWith(`${file.toLowerCase()}/`) || file.toLowerCase().startsWith(`${other}/`))) throw new Error("Duplicate, overlapping, or case-conflicting file changes.");
    seen.add(file.toLowerCase());
    if (change.content !== null && typeof change.content !== "string") throw new Error("Content must be UTF-8 text, or null to delete a file.");
    if (typeof change.content === "string") {
      bytes += Buffer.byteLength(change.content);
      if (Buffer.byteLength(change.content) > 200_000 || bytes > 1_000_000 || change.content.includes("\0")) throw new Error("Contribution text exceeds the size limit or contains binary data.");
      rejectCredentials(change.content);
    }
    return { path: file, content: change.content };
  });
}

/** Durable ownership and pending commits survive timeouts/restarts without duplicate PRs. */
export class GitHubContributions {
  private records: Contribution[];
  private queue: Promise<unknown> = Promise.resolve();
  private reviewWorker?: ContributionReviewWorker;
  private reviewRequester?: (user: string, guild: string | null) => Promise<AccessSubject>;
  constructor(readonly config: GitHubContributionConfiguration, private readonly api: ContributionApi = new GitHubContributionApi(config), private readonly reviewTransport?: ReviewTransport) {
    hostOnlyGitHubPath(config.stateFile);
    this.records = fs.existsSync(config.stateFile) ? JSON.parse(fs.readFileSync(config.stateFile, "utf8")) as Contribution[] : [];
    if (!Array.isArray(this.records) || this.records.length > 1000 || this.records.some(record =>
      !record || !/^[0-9a-f-]{36}$/.test(record.id) || record.branch !== `ai-assistant/${record.id}`
      || typeof record.session !== "string" || typeof record.user !== "string" || !this.config.repositories.some(repo => repo.upstream === record.repository))) {
      throw new Error("Invalid contribution state; restore the host-owned state file before enabling contributions.");
    }
  }

  startReviews(resolveRequester?: (user: string, guild: string | null) => Promise<AccessSubject>): void {
    if (resolveRequester) this.reviewRequester = resolveRequester;
    if (!contributionReviewsEnabled() || this.reviewWorker) return;
    if (!this.reviewRequester) throw new Error("Configure live Discord membership checks before enabling background reviews.");
    const subjects = new Map<string, AccessSubject>();
    const caller = async (owner: ReviewOwner, signal: AbortSignal, refresh: boolean): Promise<ContributionCaller> => {
      if (refresh || !subjects.has(owner.contribution)) {
        const subject = await this.reviewRequester!(owner.requester.userId, owner.requester.guildId ?? null);
        if (subject.userId !== owner.requester.userId || (subject.guildId ?? null) !== (owner.requester.guildId ?? null)) throw new Error("Review requester identity changed.");
        subjects.set(owner.contribution, subject);
      }
      signal.throwIfAborted();
      return { session: owner.session, requester: subjects.get(owner.contribution)!, access: createAccessPolicy(), signal };
    };
    this.reviewWorker = new ContributionReviewWorker(`${this.config.stateFile}.reviews.json`, {
      target: async (owner, signal) => {
        const current = await caller(owner, signal, true);
        return this.serial(current, async () => {
          const record = this.owned(current, owner.contribution);
          await this.verify(current, this.repository(record.repository));
          return this.reviewTarget(record, await this.reviewPull(current, record));
        });
      },
      request: async (owner, repository, role, method, suffix, body, signal) => {
        const current = await caller(owner, signal, method !== "GET");
        this.authorize(current);
        const record = this.owned(current, owner.contribution);
        if (record.repository !== repository.upstream) throw new Error("Review repository ownership changed.");
        return this.request(current, repository, role, method, suffix, body);
      },
    }, this.reviewTransport);
    this.reviewWorker.start();
  }
  async stopReviews(): Promise<void> { await this.reviewWorker?.close(); }
  private reviewTarget(record: Contribution, pull: PullRequest): ReviewTarget {
    return { repository: this.repository(record.repository), pull: pull.number, head: sha(pull.head.sha), base: sha(pull.base.sha), changedFiles: pull.changed_files };
  }
  private enqueueReview(caller: ContributionCaller, record: Contribution, pull: PullRequest) {
    if (!contributionReviewsEnabled()) return { enabled: false };
    this.startReviews();
    return this.reviewWorker!.enqueue({ contribution: record.id, session: caller.session, requester: { userId: caller.requester.userId, guildId: caller.requester.guildId } }, this.reviewTarget(record, pull));
  }
  private autoReviewStatus(id: string) { return contributionReviewsEnabled() ? this.reviewWorker?.status(id) ?? { enabled: true, state: "not_requested" } : { enabled: false }; }

  private authorize(caller: ContributionCaller): void {
    caller.signal.throwIfAborted();
    if (!githubContributionsEnabled() || !caller.access.can(caller.requester, "github.contribute")) throw new Error("You do not have access to GitHub contributions.");
  }
  private save(record: Contribution): void {
    hostOnlyGitHubPath(this.config.stateFile);
    const records = [...this.records.filter(item => item.id !== record.id), record];
    fs.mkdirSync(path.dirname(this.config.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.config.stateFile}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(records), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, this.config.stateFile); }
    finally { fs.rmSync(temporary, { force: true }); }
    this.records = records;
  }
  private owned(caller: ContributionCaller, id: string): Contribution {
    const record = this.records.find(item => item.id === id);
    if (!record || record.session !== caller.session || record.user !== caller.requester.userId || record.guild !== (caller.requester.guildId ?? null)) {
      throw new Error("Contribution belongs to another Discord requester or session, or no longer exists.");
    }
    return { ...record };
  }
  private repository(name: string): ContributionRepository {
    const repository = this.config.repositories.find(repo => repo.upstream === name);
    if (!repository) throw new Error("Choose an enabled contribution repository.");
    return repository;
  }
  private request<T>(caller: ContributionCaller, repository: ContributionRepository, role: GitHubRole, method: "GET" | "POST" | "PATCH", suffix: string, body?: unknown): Promise<T> {
    this.authorize(caller); // Recheck before every remote operation, including after network waits.
    return this.api.request<T>(role, repository, method, suffix, body, caller.signal);
  }
  private async verify(caller: ContributionCaller, repository: ContributionRepository): Promise<RepositoryMetadata> {
    const upstream = await this.request<RepositoryMetadata>(caller, repository, "publisher", "GET", "");
    const fork = await this.request<RepositoryMetadata>(caller, repository, "writer", "GET", "");
    if (upstream.id !== repository.upstreamId || upstream.full_name !== repository.upstream || upstream.private || upstream.archived
      || fork.id !== repository.forkId || fork.full_name !== repository.fork || !fork.fork || fork.parent?.id !== upstream.id || fork.private || fork.archived) {
      throw new Error("Repository identity or fork relationship changed; operator configuration must be reviewed.");
    }
    return upstream;
  }
  private serial<T>(caller: ContributionCaller, action: () => Promise<T>): Promise<T> {
    const operation = this.queue.catch(() => {}).then(() => { this.authorize(caller); return action(); });
    this.queue = operation;
    return operation;
  }
  private async tree(caller: ContributionCaller, record: Contribution): Promise<GitTree> {
    const result = await this.request<GitTree>(caller, this.repository(record.repository), record.published ? "writer" : "publisher", "GET", `/git/trees/${sha(record.headSha)}?recursive=1`);
    if (result.truncated || result.tree.length > 10_000) throw new Error("Repository tree exceeds the contribution limit.");
    return result;
  }
  private validatePull(record: Contribution, pull: PullRequest): void {
    const repository = this.repository(record.repository);
    if (pull.user.login !== this.config.publisherBotLogin || pull.head.repo?.id !== repository.forkId || pull.head.ref !== record.branch
      || pull.base.repo.id !== repository.upstreamId || pull.base.ref !== record.baseBranch) throw new Error("Pull request identity changed; refusing to modify it.");
  }
  private async currentPull(caller: ContributionCaller, record: Contribution): Promise<PullRequest | undefined> {
    const repository = this.repository(record.repository);
    if (record.pull) {
      const pull = await this.request<PullRequest>(caller, repository, "publisher", "GET", `/pulls/${record.pull}`);
      this.validatePull(record, pull);
      return pull;
    }
    const pulls = await this.request<PullRequest[]>(caller, repository, "publisher", "GET", `/pulls?state=all&head=${encodeURIComponent(`${repository.fork.split("/")[0]}:${record.branch}`)}&base=${encodeURIComponent(record.baseBranch)}&per_page=10`);
    if (pulls.length > 1) throw new Error("Multiple PRs reference this contribution; operator review is required.");
    if (pulls[0]) { this.validatePull(record, pulls[0]); record.pull = pulls[0].number; this.save(record); }
    return pulls[0];
  }
  private async ref(caller: ContributionCaller, record: Contribution): Promise<string | undefined> {
    try { return sha((await this.request<{ object: { sha: string } }>(caller, this.repository(record.repository), "writer", "GET", `/git/ref/heads/${record.branch}`)).object.sha); }
    catch (error) { if (error instanceof GitHubRequestError && error.status === 404) return undefined; throw error; }
  }
  private async recover(caller: ContributionCaller, record: Contribution): Promise<void> {
    const current = await this.ref(caller, record);
    if (record.pendingSha) {
      if (current !== record.pendingSha) {
        if (current !== (record.published ? record.headSha : undefined)) throw new Error("Contribution branch changed outside this session; refusing to overwrite it.");
        await this.request(caller, this.repository(record.repository), "writer", current ? "PATCH" : "POST", current ? `/git/refs/heads/${record.branch}` : "/git/refs",
          current ? { sha: record.pendingSha, force: false } : { ref: `refs/heads/${record.branch}`, sha: record.pendingSha });
      }
      record.headSha = record.pendingSha; delete record.pendingSha; record.published = true; this.save(record);
    } else if (current !== (record.published ? record.headSha : undefined)) {
      throw new Error("Contribution branch changed outside this session; refusing to overwrite it.");
    }
  }
  private summary(record: Contribution) {
    return { contribution_id: record.id, repository: record.repository, base_branch: record.baseBranch, base_sha: record.baseSha, head_sha: record.headSha,
      pull_request_url: record.pull ? `https://github.com/${record.repository}/pull/${record.pull}` : undefined, closed: record.closed };
  }

  /** Reconcile an already-authorized publish before advertising a head for the next edit. */
  private async refresh(caller: ContributionCaller, record: Contribution): Promise<PullRequest | undefined> {
    const pull = record.published || record.pendingSha ? await this.currentPull(caller, record) : undefined;
    if (pull?.state === "closed") { record.closed = true; this.save(record); }
    if (!record.closed && record.pendingSha) {
      await this.verify(caller, this.repository(record.repository));
      await this.recover(caller, record);
      return this.currentPull(caller, record);
    }
    return pull;
  }

  private async checkPublishQuota(caller: ContributionCaller, record: Contribution): Promise<void> {
    if (record.published || record.pendingSha) return;
    const unfinished = this.records.filter(item => item.user === record.user && !item.closed && (item.published || item.pendingSha));
    if (unfinished.length < 5) return;
    // Check remote closure across this user's sessions without recovering or changing their branches.
    for (const item of unfinished) {
      const previous = { ...item };
      const pull = await this.currentPull(caller, previous);
      if (pull?.state === "closed") { previous.closed = true; this.save(previous); }
    }
    if (this.records.filter(item => item.user === record.user && !item.closed && (item.published || item.pendingSha)).length >= 5) {
      throw new Error("Five unfinished published contributions are already open. Close a completed PR before publishing another.");
    }
  }

  begin(caller: ContributionCaller, repositoryName: string) {
    return this.serial(caller, async () => {
      const repository = this.repository(repositoryName);
      const upstream = await this.verify(caller, repository);
      let record = this.records.find(item => item.session === caller.session && item.user === caller.requester.userId && item.guild === (caller.requester.guildId ?? null) && item.repository === repositoryName && !item.closed);
      if (record) {
        record = { ...record };
        await this.refresh(caller, record);
        if (record.closed) record = undefined;
      }
      if (!record) {
        const owned = this.records.filter(item => item.user === caller.requester.userId);
        if (owned.filter(item => item.createdAt > Date.now() - 86_400_000).length >= 10 || this.records.length >= 1000) throw new Error("Contribution start limit reached. Wait for the daily limit or ask the operator to archive old records.");
        const base = await this.request<{ object: { sha: string } }>(caller, repository, "publisher", "GET", `/git/ref/heads/${encodeURIComponent(upstream.default_branch)}`);
        const id = randomUUID();
        record = { id, session: caller.session, user: caller.requester.userId, guild: caller.requester.guildId ?? null, repository: repositoryName,
          branch: `ai-assistant/${id}`, baseBranch: upstream.default_branch, baseSha: sha(base.object.sha), headSha: base.object.sha, published: false, closed: false, createdAt: Date.now() };
        this.save(record);
      }
      const tree = await this.tree(caller, record);
      return { ...this.summary(record), files: tree.tree.filter(entry => entry.type === "blob").map(entry => ({ path: entry.path, bytes: entry.size, mode: entry.mode })) };
    });
  }

  read(caller: ContributionCaller, id: string, file: string) {
    return this.serial(caller, async () => {
      const record = this.owned(caller, id);
      validateContributionPath(file);
      const tree = await this.tree(caller, record);
      const entry = tree.tree.find(item => item.path === file);
      if (!entry || !["100644", "100755"].includes(entry.mode) || (entry.size ?? Infinity) > 200_000) throw new Error("Choose an existing regular text file under 200 KB.");
      const blob = await this.request<{ content: string; encoding: string; size: number }>(caller, this.repository(record.repository), record.published ? "writer" : "publisher", "GET", `/git/blobs/${sha(entry.sha)}`);
      if (blob.encoding !== "base64" || blob.size > 200_000) throw new Error("Unsupported GitHub file encoding or size.");
      const data = Buffer.from(blob.content, "base64");
      if (data.includes(0)) throw new Error("Binary files are unsupported.");
      return { path: file, head_sha: record.headSha, content: new TextDecoder("utf-8", { fatal: true }).decode(data) };
    });
  }

  publish(caller: ContributionCaller, id: string, expectedHead: string, title: string, body: string, changes: ContributionChange[]) {
    return this.serial(caller, async () => {
      const record = this.owned(caller, id);
      const repository = this.repository(record.repository);
      await this.checkPublishQuota(caller, record);
      if (!title.trim() || title.length > 160 || /[\r\n]/.test(title) || body.length > 12_000) throw new Error("Use a one-line title under 160 characters and a description under 12,000 characters.");
      rejectCredentials(title); rejectCredentials(body);
      validateContributionChanges(changes);
      await this.verify(caller, repository);
      const pull = record.published ? await this.currentPull(caller, record) : undefined;
      if (record.closed || pull?.state === "closed") { record.closed = true; this.save(record); throw new Error("This contribution is closed. Start a new contribution."); }
      await this.recover(caller, record);
      if (sha(expectedHead) !== record.headSha) throw new Error("Contribution head changed. Read the current files and retry with the returned head_sha.");
      const tree = await this.tree(caller, record);
      for (const change of changes) {
        const entry = tree.tree.find(item => item.path === change.path);
        if (entry && !["100644", "100755"].includes(entry.mode)) throw new Error("Symlinks, directories, and submodules cannot be changed.");
        if (!entry && change.content === null) throw new Error("Cannot delete a missing file.");
        if (tree.tree.some(item => change.path.startsWith(`${item.path}/`) && item.type !== "tree")) throw new Error("A parent path is not a directory.");
      }
      const createdTree = await this.request<{ sha: string }>(caller, repository, "writer", "POST", "/git/trees", { base_tree: sha(tree.sha), tree: changes.map(change => ({
        path: change.path, mode: tree.tree.find(item => item.path === change.path)?.mode ?? "100644", type: "blob",
        ...(change.content === null ? { sha: null } : { content: change.content }),
      })) });
      if (createdTree.sha !== tree.sha) {
        const commit = await this.request<{ sha: string }>(caller, repository, "writer", "POST", "/git/commits", { message: title, tree: sha(createdTree.sha), parents: [record.headSha] });
        record.pendingSha = sha(commit.sha); this.save(record);
        await this.recover(caller, record);
      }
      if (!record.published) throw new Error("No file changes to publish.");
      const description = `${body.trim()}\n\n---\nContributed through AI Assistant using its dedicated GitHub Apps. Requires maintainer review and merge.`;
      const existing = pull ?? await this.currentPull(caller, record);
      const published = await this.request<PullRequest>(caller, repository, "publisher", existing ? "PATCH" : "POST", existing ? `/pulls/${existing.number}` : "/pulls", existing
        ? { title, body: description, maintainer_can_modify: false }
        : { title, body: description, head: `${repository.fork.split("/")[0]}:${record.branch}`, base: record.baseBranch, draft: true, maintainer_can_modify: false });
      this.validatePull(record, published);
      record.pull = published.number; this.save(record);
      console.info(`[github-contribution] published id=${record.id} repository=${record.repository} pr=${record.pull}`);
      return { ...this.summary(record), draft: published.draft, auto_review: this.enqueueReview(caller, record, published) };
    });
  }

  status(caller: ContributionCaller, id: string) {
    return this.serial(caller, async () => {
      const record = this.owned(caller, id);
      const pull = await this.refresh(caller, record);
      return { ...this.summary(record), draft: pull?.draft, state: pull?.state ?? "local", merged: pull?.merged ?? false, pending_publish: Boolean(record.pendingSha), remote_head_sha: pull?.head.sha, auto_review: this.autoReviewStatus(id) };
    });
  }

  private reviewRequest<T>(caller: ContributionCaller, record: Contribution, query: string, variables: Record<string, unknown>) {
    this.authorize(caller);
    return this.api.graphql<T>(this.repository(record.repository), query, variables, caller.signal);
  }

  /** Wait without holding the contribution mutex; review inference and publication continue after this turn ends. */
  async review(caller: ContributionCaller, id: string, expectedHead: string) {
    if (!contributionReviewsEnabled()) throw new Error("Server-side Codex reviews are disabled.");
    await this.serial(caller, async () => {
      const record = this.owned(caller, id);
      const pull = await this.reviewPull(caller, record, expectedHead);
      this.enqueueReview(caller, record, pull);
    });
    for (let count = 0; count < 25; count++) {
      this.authorize(caller);
      const status = this.reviewWorker!.status(id);
      if (!["queued", "submitted", "publishing"].includes(status.state)) return { auto_review: status };
      await delay(2000, undefined, { signal: caller.signal });
    }
    return { auto_review: this.reviewWorker!.status(id) };
  }

  /** Review tools never recover pending writes or accept a model-selected PR/repository identity. */
  private async reviewPull(caller: ContributionCaller, record: Contribution, expectedHead?: string) {
    if (!record.published || !record.pull || record.pendingSha) throw new Error("Publish this contribution and finish pending writes before working with reviews.");
    const pull = await this.currentPull(caller, record);
    if (!pull || record.closed || pull.state !== "open") throw new Error("This contribution is closed or unavailable.");
    if (pull.head.sha !== record.headSha || (expectedHead !== undefined && sha(expectedHead) !== record.headSha)) {
      throw new Error("Contribution head changed. Refresh the contribution before acting on reviews.");
    }
    return pull;
  }

  private validateReviewThread(record: Contribution, thread: ReviewThread | null): asserts thread is ReviewThread {
    if (!thread?.id || thread.pullRequest.number !== record.pull
      || thread.pullRequest.repository.databaseId !== this.repository(record.repository).upstreamId) {
      throw new Error("Review thread does not belong to this contribution.");
    }
    if (thread.pullRequest.state !== "OPEN" || thread.pullRequest.headRefOid !== record.headSha) throw new Error("Contribution head or state changed. Refresh its reviews.");
  }

  reviews(caller: ContributionCaller, id: string, after?: string) {
    return this.serial(caller, async () => {
      const record = this.owned(caller, id);
      await this.reviewPull(caller, record);
      if (after !== undefined && (typeof after !== "string" || after.length > 1024)) throw new Error("Invalid review pagination cursor.");
      const [owner, name] = record.repository.split("/");
      const result = await this.reviewRequest<{ repository: { pullRequest: { reviewThreads: {
        nodes: ReviewThread[]; pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } } } }>(caller, record, REVIEW_THREADS_QUERY, { owner, name, number: record.pull, after: after || null });
      const threads = result.repository?.pullRequest?.reviewThreads;
      if (!threads) throw new Error("Contribution review threads are unavailable.");
      for (const thread of threads.nodes) this.validateReviewThread(record, thread);
      return { ...this.summary(record), auto_review: this.autoReviewStatus(id), threads: threads.nodes.map(reviewThreadSummary),
        next_cursor: threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null };
    });
  }

  private async reviewThread(caller: ContributionCaller, record: Contribution, threadId: string, expectedHead: string) {
    if (!/^[A-Za-z0-9_=-]{1,256}$/.test(threadId)) throw new Error("Invalid review thread ID.");
    await this.reviewPull(caller, record, expectedHead);
    const result = await this.reviewRequest<{ node: ReviewThread | null }>(caller, record, REVIEW_THREAD_QUERY, { id: threadId });
    this.validateReviewThread(record, result.node);
    if (result.node.comments.pageInfo.hasNextPage) throw new Error("This thread exceeds 100 comments; handle it on GitHub.");
    if (!result.node.comments.nodes.length || result.node.comments.nodes.some(comment => comment.pullRequestReview?.state === "PENDING")) {
      throw new Error("Only published review threads can be changed.");
    }
    return result.node;
  }

  replyReview(caller: ContributionCaller, id: string, threadId: string, expectedHead: string, expectedVersion: string, body: string) {
    return this.serial(caller, async () => {
      const record = this.owned(caller, id);
      if (!body.trim() || body.length > 6000 || /\x00|@codex\b/i.test(body)) throw new Error("Use a nonempty review reply under 6,000 characters without Codex commands.");
      rejectCredentials(body);
      const thread = await this.reviewThread(caller, record, threadId, expectedHead);
      const reply = `AI Assistant: ${body.trim()}\n\nPublished commit: \`${record.headSha}\`.`;
      const last = thread.comments.nodes.at(-1)!;
      // A lost response can be retried safely, even after a host restart.
      if (isPublisherComment(last, this.config.publisherBotLogin) && last.body === reply) {
        return { thread_id: threadId, comment_id: last.id, comment_url: last.url, already_replied: true };
      }
      if (thread.isResolved) throw new Error("This review thread is already resolved.");
      if (reviewThreadVersion(thread) !== expectedVersion) throw new Error("Review thread changed. Read the latest feedback before replying.");
      const result = await this.reviewRequest<{ addPullRequestReviewThreadReply: { comment: { id: string; url: string } } }>(caller, record, REPLY_REVIEW_THREAD, { thread: threadId, body: reply });
      console.info(`[github-contribution] review-reply id=${record.id} pr=${record.pull} thread=${threadId}`);
      return { thread_id: threadId, comment_id: result.addPullRequestReviewThreadReply.comment.id, comment_url: result.addPullRequestReviewThreadReply.comment.url, already_replied: false };
    });
  }

  resolveReview(caller: ContributionCaller, id: string, threadId: string, expectedHead: string, expectedVersion: string) {
    return this.serial(caller, async () => {
      const record = this.owned(caller, id);
      const thread = await this.reviewThread(caller, record, threadId, expectedHead);
      if (thread.isResolved) return { thread_id: threadId, resolved: true, already_resolved: true };
      if (reviewThreadVersion(thread) !== expectedVersion) throw new Error("Review thread changed. Read the latest feedback before resolving.");
      const first = thread.comments.nodes[0];
      const last = thread.comments.nodes.at(-1)!;
      if (!first.commit || first.commit.oid === record.headSha
        || !isPublisherComment(last, this.config.publisherBotLogin) || !last.body.endsWith(`\n\nPublished commit: \`${record.headSha}\`.`)) {
        throw new Error("Publish the fix and reply explaining it at the current head before resolving this thread.");
      }
      if (!thread.viewerCanResolve) throw new Error("The publisher App cannot resolve this review thread.");
      const result = await this.reviewRequest<{ resolveReviewThread: { thread: { id: string; isResolved: boolean } } }>(caller, record, RESOLVE_REVIEW_THREAD, { thread: threadId });
      if (!result.resolveReviewThread?.thread.isResolved) throw new Error("GitHub did not confirm review thread resolution.");
      console.info(`[github-contribution] review-resolve id=${record.id} pr=${record.pull} thread=${threadId}`);
      return { thread_id: threadId, resolved: true, already_resolved: false };
    });
  }
}

let configured: GitHubContributions | undefined;
export function githubContributionService(): GitHubContributions {
  if (!githubContributionsEnabled()) throw new Error("GitHub contributions are disabled.");
  return configured ??= new GitHubContributions(loadGitHubContributionConfiguration());
}
