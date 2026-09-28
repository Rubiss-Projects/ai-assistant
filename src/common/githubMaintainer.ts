import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitHubContributions } from "./githubContributions.js";
import { GitHubActionError, GitHubRequestNotSentError, type GitHubUserAuth, type UserGitHubClient, writeGitHubState } from "./githubUserAuth.js";
import { hostOnlyGitHubPath } from "./githubContributionConfig.js";

export type ActionTarget = ReturnType<GitHubContributions["actionTargets"]>[number];
export type MaintainerAction = "ready" | "approve" | "merge" | "release";
export interface ActionContext {
  userId: string; guild: string; channel: string; signal: AbortSignal;
  authorize(action: MaintainerAction | "read"): Promise<void>;
}
interface Attempt { login?: string; notification?: { id: string; content: string; message?: string }; action: MaintainerAction; user: number; discordUser: string; state: "pending" | "done"; at: number }
export interface ContributionCard {
  id: string; contribution: string; session: string; guild: string; channel: string; message?: string;
  repository: string; pull: number; head: string; base?: string; created: number;
  closed?: boolean; draft?: boolean; merged?: string; release?: { tag: string; sha: string; previous: string; notes: string; run?: number; url?: string; state?: string };
  attempts: Attempt[];
}
interface Review { author: { login: string } | null; state: string; commit: { oid: string } | null }
export interface PullSnapshot {
  id: string; title: string; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; headRefOid: string; baseRefOid: string; baseRefName: string;
  author: { __typename: string; login: string } | null; headRefName: string; headRepository: { databaseId: number } | null;
  mergeCommit: { oid: string } | null; mergeable: string; mergeStateStatus: string; reviewDecision: string | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  reviews: { nodes: Review[]; pageInfo: { hasPreviousPage: boolean } };
  reviewThreads: { nodes: { isResolved: boolean }[]; pageInfo: { hasNextPage: boolean } };
}
const PULL_QUERY = `query($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { databaseId nameWithOwner defaultBranchRef { name } pullRequest(number:$number) {
    id title state isDraft headRefOid baseRefOid baseRefName headRefName author { __typename login } headRepository { databaseId }
    mergeCommit { oid } mergeable mergeStateStatus reviewDecision
    commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    reviews(last:100) { nodes { author { login } state commit { oid } } pageInfo { hasPreviousPage } }
    reviewThreads(first:100) { nodes { isResolved } pageInfo { hasNextPage } }
  } }
}`;

function commit(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new GitHubActionError("GitHub returned an invalid commit.");
  return value;
}

export function nextReleaseTag(tags: readonly string[]): string {
  const stable = tags.map(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)).filter(match => match !== null)
    .map(match => match.slice(1).map(Number)).filter(parts => parts.every(Number.isSafeInteger));
  stable.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const [major, minor, patch] = stable[0] ?? [0, 0, 0];
  if (!Number.isSafeInteger(patch + 1)) throw new GitHubActionError("Choose the next release version on GitHub.");
  return `v${major}.${minor}.${patch + 1}`;
}

/** Human-only operations. This service is never registered as a model tool. */
export class GitHubMaintainer {
  private cards: ContributionCard[];
  private readonly queues = new Map<string, Promise<unknown>>();
  private releasePollOffset = 0;
  private readonly file: string;
  constructor(private readonly auth: Pick<GitHubUserAuth, "client">, private readonly targets: (session: string, guild: string) => ActionTarget[], directory: string) {
    this.file = hostOnlyGitHubPath(path.join(directory, "cards.json"));
    this.cards = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) as ContributionCard[] : [];
    if (!Array.isArray(this.cards) || this.cards.length > 1000 || this.cards.some(card => !/^[a-f0-9-]{36}$/.test(card.id) || !card.guild || !card.channel || !Array.isArray(card.attempts))) throw new Error("Invalid GitHub action card store.");
  }
  private save() { writeGitHubState(this.file, this.cards); }
  pendingReleases(limit = 10) {
    const pending = this.cards.filter(card => card.release && card.attempts.some(attempt => attempt.action === "release") && !["success", "failure", "cancelled", "timed_out", "action_required", "skipped", "neutral", "stale", "startup_failure"].includes(card.release.state ?? ""));
    const start = this.releasePollOffset % (pending.length || 1);
    const batch = [...pending.slice(start), ...pending.slice(0, start)].slice(0, limit);
    this.releasePollOffset = start + batch.length;
    return batch;
  }
  pendingNotifications() {
    return this.cards.filter(card => card.attempts.some(attempt => attempt.notification && !attempt.notification.message));
  }
  notificationSent(card: ContributionCard, id: string, message: string) {
    const notification = card.attempts.find(attempt => attempt.notification?.id === id)?.notification;
    if (notification) { notification.message = message; this.save(); }
  }
  private complete(card: ContributionCard, attempt: Attempt, description: string) {
    attempt.state = "done";
    attempt.notification ??= { id: randomUUID(), content: `**${card.repository} #${card.pull}** ${description}${attempt.login ? ` by @${attempt.login}` : ""}.\nhttps://github.com/${card.repository}/pull/${card.pull}` };
    this.save();
  }
  private reconcile(card: ContributionCard, pull: PullSnapshot) {
    card.draft = pull.isDraft;
    for (const attempt of card.attempts) {
      if (attempt.action === "ready" && !pull.isDraft) this.complete(card, attempt, "marked ready for review");
      if (attempt.action === "approve" && attempt.login && this.approvedBy(pull, attempt.login)) this.complete(card, attempt, `approved revision \`${card.head.slice(0, 12)}\``);
      if (attempt.action === "merge" && pull.state === "MERGED") this.complete(card, attempt, "merged");
    }
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(id, pending);
    void pending.finally(() => { if (this.queues.get(id) === pending) this.queues.delete(id); }).catch(() => {});
    return pending;
  }
  private target(card: ContributionCard): ActionTarget {
    const target = this.targets(card.session, card.guild).find(target => target.id === card.contribution);
    if (!target || target.repository.upstream !== card.repository || target.pull !== card.pull || target.baseBranch !== "main") throw new GitHubActionError("This contribution is no longer available for thread actions.");
    return target;
  }
  get(id: string, context: Pick<ActionContext, "guild" | "channel">): ContributionCard {
    const card = this.cards.find(card => card.id === id && card.guild === context.guild && card.channel === context.channel);
    if (!card) throw new GitHubActionError("This action card expired or belongs to another conversation. Use /github status.");
    this.target(card); return card;
  }
  forConversation(session: string, guild: string, channel: string): ContributionCard[] {
    const targets = this.targets(session, guild);
    const result: ContributionCard[] = [];
    for (const target of targets.slice(-5)) {
      const reviewedBase = "base_sha" in target.review ? target.review.base_sha : undefined;
      let card = this.cards.find(card => card.contribution === target.id && card.guild === guild && card.channel === channel && card.head === target.head && (card.merged || card.base === reviewedBase));
      if (!card) {
        if (this.cards.length >= 1000) throw new GitHubActionError("GitHub action history is full. Operator maintenance is required.");
        // New buttons bind the new revision, but keep the PR's one public message.
        const previous = this.cards.filter(item => item.contribution === target.id && item.guild === guild && item.channel === channel).at(-1);
        card = { message: previous?.message, id: randomUUID(), contribution: target.id, session, guild, channel, repository: target.repository.upstream, pull: target.pull,
          head: target.head, base: reviewedBase, created: Date.now(), attempts: [] };
        this.cards.push(card); this.save();
      }
      result.push(card);
    }
    return result;
  }
  setMessage(card: ContributionCard, message: string) { card.message = message; this.save(); }
  reviewReady(card: ContributionCard): boolean {
    const review = this.target(card).review;
    return "head_sha" in review && review.state === "completed" && review.head_sha === card.head && review.base_sha === card.base && review.result?.findings.length === 0;
  }
  private async graphql<T>(api: UserGitHubClient, query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await api.request<{ data?: T; errors?: unknown[] }>("POST", "/graphql", { query, variables });
    if (result.errors?.length || !result.data) throw new GitHubActionError("GitHub could not verify this action. Refresh the card.");
    return result.data;
  }
  private async snapshot(api: UserGitHubClient, card: ContributionCard): Promise<PullSnapshot> {
    const target = this.target(card);
    const [owner, name] = card.repository.split("/");
    const result = await this.graphql<{ repository: { databaseId: number; nameWithOwner: string; defaultBranchRef: { name: string }; pullRequest: PullSnapshot } | null }>(api, PULL_QUERY, { owner, name, number: card.pull });
    const repo = result.repository, pull = repo?.pullRequest;
    if (!repo || repo.databaseId !== target.repository.upstreamId || repo.nameWithOwner !== card.repository || repo.defaultBranchRef?.name !== "main" || !pull
      || pull.baseRefName !== "main" || pull.headRefName !== target.branch || pull.headRepository?.databaseId !== target.repository.forkId
      || pull.author?.__typename !== "Bot" || `${pull.author.login}[bot]` !== target.publisher) throw new GitHubActionError("The PR's repository, author, or branch changed. Refusing this action.");
    if (pull.headRefOid !== card.head || target.head !== card.head) throw new GitHubActionError("The PR changed. Use /github status for a new card, then review that revision.");
    commit(pull.headRefOid); commit(pull.baseRefOid);
    return pull;
  }
  private reviewed(card: ContributionCard, pull: PullSnapshot): void {
    const review = this.target(card).review;
    if (!("base_sha" in review) || !this.reviewReady(card) || review.base_sha !== pull.baseRefOid) throw new GitHubActionError("A completed clean server review of the current head and base is required. Ask the assistant to finish its review first.");
    if (card.base && card.base !== pull.baseRefOid) throw new GitHubActionError("The target branch changed. Refresh the card and review the new result.");
    card.base = pull.baseRefOid;
    if (pull.state !== "OPEN") throw new GitHubActionError("This PR is no longer open.");
    if (pull.reviews.pageInfo.hasPreviousPage || pull.reviewThreads.pageInfo.hasNextPage) throw new GitHubActionError("This PR exceeds the thread review limit; handle it on GitHub.");
    if (pull.reviewThreads.nodes.some(thread => !thread.isResolved)) throw new GitHubActionError("Resolve the remaining review threads before approval or merging.");
    if (pull.commits.nodes.at(-1)?.commit.statusCheckRollup?.state !== "SUCCESS") throw new GitHubActionError("The PR's checks are pending or failing. Refresh after they pass.");
  }
  private attempt(card: ContributionCard, action: MaintainerAction, user: number, discordUser: string, login: string): Attempt {
    const previous = card.attempts.find(attempt => attempt.action === action && (action !== "approve" || attempt.user === user));
    if (previous) throw new GitHubActionError("This action was already sent. Refresh to reconcile its outcome; it will not be sent twice.");
    if (card.attempts.length >= 100) throw new GitHubActionError("This PR has reached its action limit.");
    const attempt: Attempt = { action, user, discordUser, login, state: "pending", at: Date.now() }; card.attempts.push(attempt); this.save(); return attempt;
  }
  private async send<T>(card: ContributionCard, attempt: Attempt, request: () => Promise<T>): Promise<T> {
    try { return await request(); }
    catch (error) {
      // A documented client rejection did not mutate GitHub. Network/5xx failures
      // are ambiguous and retain the durable receipt until reconciled.
      if (error instanceof GitHubRequestNotSentError || (error instanceof GitHubActionError && [400, 401, 403, 404, 405, 409, 422, 429].includes(error.status ?? 0))) {
        card.attempts = card.attempts.filter(item => item !== attempt); this.save();
      }
      throw error;
    }
  }
  private approvedBy(pull: PullSnapshot, login: string): boolean {
    const last = pull.reviews.nodes.filter(review => review.author?.login === login && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)).at(-1);
    return last?.state === "APPROVED" && last.commit?.oid === pull.headRefOid;
  }
  private async canWrite(api: UserGitHubClient, card: ContributionCard): Promise<void> {
    const repo = await api.request<{ permissions?: { push?: boolean }; archived: boolean }>("GET", `/repos/${card.repository}`);
    if (!repo.permissions?.push || repo.archived) throw new GitHubActionError("Your linked GitHub account does not have write access to this repository.");
  }
  async act(id: string, action: MaintainerAction, context: ActionContext): Promise<string> {
    return this.serial(id, async () => {
      await context.authorize(action);
      const card = this.get(id, context);
      const api = await this.auth.client(context.userId, context.signal, () => context.authorize(action));
      let pull = await this.snapshot(api, card);
      this.reconcile(card, pull);
      if (action === "release") return this.release(api, card, pull, context.userId);
      if (action === "merge" && pull.state === "MERGED") { card.merged = commit(pull.mergeCommit!.oid); this.save(); return "This PR is already merged. Refresh to prepare its release."; }
      this.reviewed(card, pull);
      if (action === "ready") {
        await this.canWrite(api, card);
        if (!pull.isDraft) return "This PR is already ready for review.";
        await this.markReady(api, card, pull, context.userId);
        return `Marked ready for review as @${api.user.login}.`;
      }
      if (action === "approve") {
        if (this.approvedBy(pull, api.user.login)) return `@${api.user.login} already approved this revision. GitHub determines whether it satisfies required reviews.`;
        const attempt = this.attempt(card, action, api.user.id, context.userId, api.user.login);
        await this.send(card, attempt, () => api.request("POST", `/repos/${card.repository}/pulls/${card.pull}/reviews`, { event: "APPROVE", commit_id: card.head,
          body: `Approved by @${api.user.login} through their linked Discord account. Revision: ${card.head}.` }));
        this.complete(card, attempt, `approved revision \`${card.head.slice(0, 12)}\``);
        return `Approval submitted as @${api.user.login}. GitHub determines whether it satisfies required reviews. This does not authorize merging or releasing.`;
      }
      await this.canWrite(api, card);
      // On unprotected branches, require this authorized maintainer's own approval; a
      // contributor's informational approval must never satisfy the bot's merge gate.
      if (pull.reviewDecision !== "APPROVED" && !this.approvedBy(pull, api.user.login)) throw new GitHubActionError("Required reviews are not satisfied. Approve this revision with your maintainer account first.");
      if (pull.reviewDecision === "CHANGES_REQUESTED" || pull.reviewDecision === "REVIEW_REQUIRED") throw new GitHubActionError("GitHub's required reviews are not satisfied.");
      if (pull.isDraft) {
        await this.markReady(api, card, pull, context.userId);
        pull = await this.snapshot(api, card); this.reviewed(card, pull);
      }
      if (pull.mergeable !== "MERGEABLE" || pull.mergeStateStatus !== "CLEAN") throw new GitHubActionError("GitHub is not ready to merge this PR. Refresh once all repository requirements pass.");
      const attempt = this.attempt(card, action, api.user.id, context.userId, api.user.login);
      const result = await this.send(card, attempt, () => api.request<{ merged: boolean; sha: string }>("PUT", `/repos/${card.repository}/pulls/${card.pull}/merge`, { sha: card.head, merge_method: "rebase" }));
      if (result.merged === false) {
        card.attempts = card.attempts.filter(item => item !== attempt); this.save();
        throw new GitHubActionError("GitHub did not merge this PR. Resolve its blocking conditions, then retry.");
      }
      if (result.merged !== true) throw new GitHubActionError("GitHub did not confirm the merge. Refresh to check its outcome.");
      card.merged = commit(result.sha); this.complete(card, attempt, "merged");
      return `Merged as @${api.user.login}. Refresh to check the merged commit and prepare a release.`;
    });
  }
  private async markReady(api: UserGitHubClient, card: ContributionCard, pull: PullSnapshot, discordUser: string) {
    const attempt = this.attempt(card, "ready", api.user.id, discordUser, api.user.login);
    await this.send(card, attempt, () => this.graphql(api, "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}", { id: pull.id }));
    const current = await this.snapshot(api, card);
    if (current.isDraft) throw new GitHubActionError("GitHub did not confirm ready for review. Refresh to check its outcome.");
    card.draft = false;
    this.complete(card, attempt, "marked ready for review");
  }
  async refresh(id: string, context: ActionContext): Promise<{ card: ContributionCard; pull: PullSnapshot; actor: string }> {
    return this.serial(id, async () => {
      await context.authorize("read");
      const card = this.get(id, context);
      const api = await this.auth.client(context.userId, context.signal, () => context.authorize("read"));
      const pull = await this.snapshot(api, card);
      this.reconcile(card, pull);
      card.closed = pull.state === "CLOSED";
      if (pull.state === "MERGED") {
        card.merged = commit(pull.mergeCommit!.oid);
        if (card.repository === "Rubiss-Projects/ai-assistant") {
          if (!card.attempts.some(attempt => attempt.action === "release")) await this.planRelease(api, card);
          else await this.releaseStatus(api, card);
        }
      } else if (pull.state === "OPEN" && card.base !== pull.baseRefOid) {
        throw new GitHubActionError("The target branch changed. Ask the assistant to review the updated base, then use /github status for a new card.");
      }
      this.save(); return { card, pull, actor: api.user.login };
    });
  }
  private async planRelease(api: UserGitHubClient, card: ContributionCard): Promise<void> {
    const tags: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await api.request<{ name: string }[]>("GET", `/repos/${card.repository}/tags?per_page=100&page=${page}`);
      tags.push(...result.map(tag => tag.name));
      if (result.length < 100) break;
      if (page === 10) throw new GitHubActionError("Release history exceeds the supported limit.");
    }
    const previous = (await api.request<{ tag_name: string }>("GET", `/repos/${card.repository}/releases/latest`)).tag_name;
    const sha = commit(card.merged!);
    const comparison = await api.request<{ status: string; total_commits: number; commits: { commit: { message: string } }[] }>("GET", `/repos/${card.repository}/compare/${encodeURIComponent(previous)}...${sha}?per_page=100`);
    if (comparison.status !== "ahead" || comparison.total_commits < 1 || comparison.total_commits > 100 || comparison.commits.length !== comparison.total_commits) throw new GitHubActionError("This commit is already released, behind the latest release, or has too many changes for a thread release.");
    const notes = comparison.commits.map(item => `• ${item.commit.message.split("\n")[0].slice(0, 150)}`).join("\n");
    card.release = { tag: nextReleaseTag(tags), sha, previous, notes };
  }
  private async releaseStatus(api: UserGitHubClient, card: ContributionCard): Promise<void> {
    const release = card.release!;
    if (!release.run) {
      const attempt = card.attempts.find(attempt => attempt.action === "release");
      if (!attempt) return;
      const runs = await api.request<{ workflow_runs: { id: number; display_title: string; actor: { id: number }; head_sha: string; created_at: string }[] }>("GET", `/repos/${card.repository}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100`);
      const matches = runs.workflow_runs.filter(run => run.display_title === `Release ${release.tag} @${release.sha}` && run.actor.id === attempt.user && run.head_sha === release.sha && Date.parse(run.created_at) >= attempt.at - 5000);
      if (matches.length !== 1) throw new GitHubActionError("Release dispatch is awaiting reconciliation. It will not be sent twice; check GitHub Actions if no run appears.");
      release.run = matches[0].id;
    }
    const run = await api.request<{ status: string; conclusion: string | null; html_url: string; path: string; head_sha: string }>("GET", `/repos/${card.repository}/actions/runs/${release.run}`);
    if (run.path !== ".github/workflows/release.yml" || run.head_sha !== release.sha) throw new GitHubActionError("Release workflow identity or commit changed.");
    const state = run.status === "completed" ? run.conclusion ?? "unknown" : run.status;
    let url = `https://github.com/${card.repository}/actions/runs/${release.run}`;
    if (state === "success") {
      const published = await api.request<{ draft: boolean; tag_name: string }>("GET", `/repos/${card.repository}/releases/tags/${release.tag}`);
      let tag = await api.request<{ object: { sha: string; type: string } }>("GET", `/repos/${card.repository}/git/ref/tags/${release.tag}`);
      // Annotated tags point to tag objects, which may themselves wrap another tag.
      for (let depth = 0; tag.object.type === "tag" && depth < 10; depth++) {
        tag = await api.request<typeof tag>("GET", `/repos/${card.repository}/git/tags/${commit(tag.object.sha)}`);
      }
      if (published.draft || published.tag_name !== release.tag || tag.object.type !== "commit" || tag.object.sha !== release.sha) throw new GitHubActionError("Publication completed but the release commit could not be verified.");
      url = `https://github.com/${card.repository}/releases/tag/${release.tag}`;
    }
    release.state = state; release.url = url;
    if (state === "success") {
      const attempt = card.attempts.find(attempt => attempt.action === "release")!;
      this.complete(card, attempt, `released as **${release.tag}** (${url})`);
    }
  }
  private async release(api: UserGitHubClient, card: ContributionCard, pull: PullSnapshot, discordUser: string): Promise<string> {
    if (card.repository !== "Rubiss-Projects/ai-assistant" || pull.state !== "MERGED" || !card.release || card.release.sha !== pull.mergeCommit?.oid) throw new GitHubActionError("Merge this PR and refresh to preview the exact release before publishing.");
    const release = card.release;
    await this.canWrite(api, card);
    // The release workflow independently checks this commit and CI, closing the dispatch race.
    const latest = await api.request<{ tag_name: string }>("GET", `/repos/${card.repository}/releases/latest`);
    if (latest.tag_name !== release.previous) throw new GitHubActionError("Another release was published. Prepare a fresh release plan.");
    const branch = await api.request<{ commit: { sha: string } }>("GET", `/repos/${card.repository}/branches/main`);
    if (branch.commit.sha !== release.sha) throw new GitHubActionError("Main changed after this merge. Release its current reviewed PR instead.");
    const ci = await api.request<{ workflow_runs: { path: string; head_sha: string; status: string; conclusion: string | null }[] }>("GET", `/repos/${card.repository}/actions/workflows/ci.yml/runs?head_sha=${release.sha}&event=push&per_page=100`);
    const run = ci.workflow_runs[0];
    if (!run || run.path !== ".github/workflows/ci.yml" || run.head_sha !== release.sha || run.status !== "completed" || run.conclusion !== "success") throw new GitHubActionError("The merged commit's CI must pass before releasing. Refresh after it completes.");
    const attempt = this.attempt(card, "release", api.user.id, discordUser, api.user.login);
    // API version 2026-03-10 returns run details by default. Reconcile an empty successful response too.
    const result = await this.send(card, attempt, () => api.request<{ workflow_run_id: number } | undefined>("POST", `/repos/${card.repository}/actions/workflows/release.yml/dispatches`, {
      ref: "main", inputs: { tag: release.tag, expected_sha: release.sha },
    }));
    if (!result || !Number.isSafeInteger(result.workflow_run_id)) {
      release.state = "awaiting receipt"; this.save();
      return `Release ${release.tag} requested as @${api.user.login}. Its run receipt is pending; Refresh will reconcile publication without sending another request.`;
    }
    release.run = result.workflow_run_id; release.state = "queued"; release.url = `https://github.com/${card.repository}/actions/runs/${release.run}`;
    attempt.state = "done"; this.save();
    return `Release ${release.tag} requested as @${api.user.login}. Publication is running: ${release.url}`;
  }
}
