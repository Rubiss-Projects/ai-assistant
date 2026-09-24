import { createHash } from "node:crypto";
const THREAD_FIELDS = `id isResolved isOutdated viewerCanResolve path line
  pullRequest { number repository { databaseId } headRefOid state }
  comments(first: 100) {
    nodes { id author { __typename login } body url updatedAt commit { oid } pullRequestReview { state } }
    pageInfo { hasNextPage }
  }`;
export const REVIEW_THREADS_QUERY = `query ContributionReviews($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 25, after: $after) { nodes { ${THREAD_FIELDS} } pageInfo { hasNextPage endCursor } }
    }
  }
}`;
export const REVIEW_THREAD_QUERY = `query ContributionReviewThread($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { ${THREAD_FIELDS} } }
}`;
export const REPLY_REVIEW_THREAD = `mutation ContributionReviewReply($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id url } }
}`;
export const RESOLVE_REVIEW_THREAD = `mutation ContributionReviewResolve($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } }
}`;
/** GraphQL Bot.login omits REST's [bot] suffix; require the actor type as well as the exact App login. */
export function isPublisherComment(comment, botLogin) {
    return comment.author?.__typename === "Bot" && `${comment.author.login}[bot]` === botLogin;
}
/** Detect new/edited feedback as well as resolution changes between reading and acting. */
export function reviewThreadVersion(thread) {
    return createHash("sha256").update(JSON.stringify({ resolved: thread.isResolved, outdated: thread.isOutdated, comments: thread.comments })).digest("hex");
}
export function reviewThreadSummary(thread) {
    return { thread_id: thread.id, thread_version: reviewThreadVersion(thread), resolved: thread.isResolved,
        outdated: thread.isOutdated, can_resolve: thread.viewerCanResolve, path: thread.path, line: thread.line,
        comments_truncated: thread.comments.pageInfo.hasNextPage,
        comments: thread.comments.nodes.filter(comment => comment.pullRequestReview?.state !== "PENDING").map(comment => ({
            comment_id: comment.id, author: comment.author?.login, body: comment.body, url: comment.url, commit_sha: comment.commit?.oid,
        })),
    };
}
