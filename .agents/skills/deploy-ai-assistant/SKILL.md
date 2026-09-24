---
name: deploy-ai-assistant
description: Ship AI Assistant through app PR review, release publication, Docker repository version-promotion PR, and verification of the running assistant and browser containers. Use for releasing or deploying this repository.
---

# Deploy AI Assistant

A release is deployed only when the intended revision runs in production. Publishing a GitHub release or a container image does not update the running installation. A request to complete the release authorizes the following sequence; do not ask again for each already-authorized step. Creating this skill or discussing deployment does not itself authorize a release.

## Deployment map

- Application: `Rubiss-Projects/ai-assistant`, target `main`.
- Release workflow: `.github/workflows/release.yml`, triggered by a new `v*` tag or manual dispatch.
- Image: `ghcr.io/rubiss-projects/ai-assistant:<version>`, published for `linux/amd64` and `linux/arm64`.
- Infrastructure: `Rubiss-Projects/docker`, target `main`, `ai-assistant/docker-compose.yml`.
- Promote **both references to the same image**: services `ai-assistant` and `browser`; containers `ai-assistant` and `ai-assistant-browser`.
- Runtime: Ben-Server, Docker Desktop through Ubuntu/WSL; canonical deployed checkout `/mnt/e/Docker`.
- Deployment workflow: Docker repo `.github/workflows/deploy-service-changes.yml`, **Deploy Service Changes**, especially **Deploy main-host service folders**.

Fetch both repositories and inspect their current workflows before acting. Read the Docker repo's `AGENTS.md`, `.agents/skills/merge-to-main/SKILL.md`, and any nearer service guidance. Local sibling checkouts may be stale. Use an isolated feature worktree and preserve unrelated changes. Before merging a Docker PR, verify the canonical deployment checkout is clean on `main`, as its guidance requires; never discard another person's work to make it clean.

## Application PR and reviews

1. Verify repository identity and GitHub authentication. Run focused tests, the complete Linux unit suite, and `npm run build`. Keep tracked `dist/` output consistent. Require the current CI build and container-runtime checks before merging.
2. Commit task files as Ben without model co-authorship. Fetch and rebase onto the latest target before opening the PR. Follow current repository title conventions and keep the description focused on the problem, resulting behavior, validation, and rollout dependencies.
3. For an explicitly requested stack, target the prerequisite branch and describe the dependency. Merge the prerequisite first, rebase only this PR's commits onto current `main`, retarget, and validate the resulting head. Do not assume checks against an earlier base cover the final merge candidate.
4. Maintain a review ledger with repository, PR, exact reviewed SHA, round, findings, and resolution. Obtain at most **five Codex review rounds per PR**, including automatic opening reviews. Each prerequisite, application, and Docker promotion PR has its own budget. This is a ceiling, not a target; stop once the current head has a clean review and passing checks.
5. Inspect the automatic review first. A running summary, no inline comments, or green CI does not establish a completed clean review. Check the completed Codex summary and published feedback for the current SHA. Request `@codex review` only if no review of that SHA is already scheduled/running and budget remains; never launch duplicate concurrent reviews.
   If a fork PR's triggers remain unacknowledged after a bounded retry, a temporary same-repository review PR may point to the **identical head SHA and base branch**. Its completed review is evidence for that exact prerequisite; the original and mirror share that PR's five-round budget. Apply any findings to the prerequisite and close the mirror without merging after the original PR merges. Do not substitute a different tree or an older review.
6. Address valid findings, test, push, and obtain another review when needed. Resolve only eligible addressed threads, following the babysit skill's rules. Do not post replies to other humans without approval of the exact reply.
7. Use the installed `babysit-pr` skill in continuous watch mode when available; otherwise poll review feedback, checks, and mergeability with `gh` about once a minute. Own and consume the watcher through completion. Resume monitoring after every push; green checks or an idle snapshot are intermediate states while a PR remains open. Diagnose failed jobs before retrying; use the babysitter's bounded retry policy for unrelated flakes.
8. Stop early once the current head has a completed clean review and passing required checks. Re-read head SHA, threads, checks, and mergeability immediately before merging. Use the repository's allowed merge method (currently rebase for the app); do not bypass protections. Record the resulting main SHA, which may differ from the reviewed head.

At a PR's review cap, do not request a sixth review or override unresolved material findings. Report the exact blocker if that PR needs another review for safe promotion. Stop monitoring only when merged/closed or when concrete user help is required, not merely because review takes time.

## Publish the release

1. Inspect existing releases and tags. Choose the next appropriate SemVer and tag the exact verified merged commit. Never move an existing release tag or let a moving branch choose the release revision accidentally.
2. Push the tag and follow the **Release** workflow for that tag/SHA. It installs dependencies, tests, builds, publishes the multi-platform image, creates the GitHub release, and promotes the highest eligible stable release to `latest`. Both runtime services use this one image; there is no separate browser image build.
3. Require successful publication. Verify the tag resolves to the intended commit and inspect image version/revision labels or provenance. Add concise release notes explaining behavior, migration implications, and any operator action. Include other unreleased changes since the preceding tag accurately.
4. Record the previous compatible production version for rollback. Before a session-store format migration, save a private backup of `/data/.config/ai-assistant/sessions*.json` outside the provider workspace, without logging its contents. Older string-only readers require those compatible maps restored while the assistant is stopped, or an explicit session reset, before downgrading; preserve native provider history and note that restoring a backup can omit subsequent conversation progress. An image published successfully is still awaiting deployment.

## Promote through the Docker repository

1. Fetch current Docker `main`; check for an existing matching promotion PR. Use a clean branch/worktree. Read the current Compose file and validation workflow.
2. Change both AI Assistant image references to the published immutable version tag. Preserve commands, networks, limits, health checks, volumes, credentials, and the assistant's graceful shutdown period. Keep `ai-assistant-browser` off `proxynet`, with no published host port and no bot credentials/data volume; its control API is private.
3. Validate with the repository's checks and quiet Compose validation. Do not print resolved secret-bearing configuration or dump `.env.secret`. Configuration/schema changes need an explicit compatible rollout; do not enable unrelated features as part of a version-only promotion.
4. Commit, rebase onto current Docker `main`, and open a concise promotion PR linking the app PR and release. Obtain Codex review within the promotion PR's own five-round budget, address valid findings, and babysit until review and required checks pass. Follow the Docker merge skill and recheck canonical checkout hygiene before merging.
5. Follow **Deploy Service Changes** for the exact Docker merge SHA. Require the AI Assistant scope to be pulled/recreated by the main-host job. Do not use skip-deploy tokens, dispatch an alternate self-hosted workflow, or treat a skipped deployment as success.
6. Inspect the deployment helper's current verification and workflow logs. Establish the actual running image ID, version/revision, and health of **both** containers; healthy old containers are not evidence of rollout. Confirm a fresh Discord login/ready event and browser `/health` success. For behavior changes, use scoped read-only runtime checks or observed relevant work; never post test messages into Discord without authorization. State any behavior that could only be verified before deployment.

Prefer deployment automation to manual restarts. Use read-only host inspection if runner evidence is insufficient. The existing SSH target is `ben-server` (`Rubiss@192.168.50.40`); verify hostname `Ben-Server`. Remote commands start in Windows, so run Linux/Docker commands through `wsl -d Ubuntu -- ...`. If the key is rejected, the local password source is `C:\Users\Rubis\Projects\ben-server.txt`: read it only into a temporary SSH_ASKPASS helper, never tool output, arguments, Git, or this skill. Set `SSH_ASKPASS_REQUIRE=force`, use password authentication, and remove helpers afterward. Do not execute the helper directly. Do not ask for a deployment target already identified above.

## Completion and recovery

Report the app PR and merged SHA, review count, release URL, Docker promotion PR and merge SHA, deployment workflow outcome, and runtime evidence. Clearly label incomplete stages. A full release remains incomplete until promotion and runtime verification finish.

On failure, stop further promotion and diagnose that stage. Report inaccessible runners, registry authentication failures, or dirty canonical checkouts precisely. When rollback is appropriate, promote the previous compatible version through a reviewed Docker PR, preserving data and checking session-store/schema compatibility first. Never remove persistent volumes, rewrite release history, restart unrelated services, or invent successful checks.
