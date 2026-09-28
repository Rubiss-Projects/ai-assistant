# GitHub contributions

Authorized Discord users can ask the assistant to propose a change to
`Rubiss-Projects/ai-assistant` or `Rubiss-Projects/docker`, then revise the resulting
draft pull request in the same conversation, read its review threads, reply to
feedback, and resolve addressed findings. For example: “Implement a clearer
error message for missing attachments and open a draft PR in AI Assistant.”
The model cannot approve, merge, release, or enable auto-merge. With optional
[linked GitHub actions](#linked-github-actions-in-discord), people can approve,
merge, and release through authenticated Discord buttons using their own GitHub
accounts. Otherwise maintainers review, mark ready, and merge on GitHub.

## Configuration

The feature is disabled by default and requires `AI_ASSISTANT_SECURITY_MODE=shared`.
It runs inside the existing bot host; no additional container or exposed port is
required. All three providers use the same authenticated local MCP bridge.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS` | `false` | Enable the contribution tools. |
| `GITHUB_CONTRIBUTIONS_ACCESS` | `granted` | `granted` requires an explicit `github.contribute` capability, `contributor` rights preset, or explicit bot-admin grant. `chat` permits the existing chat audience as well. |
| `GITHUB_CONTRIBUTIONS_CONFIG_FILE` | Required when enabled | Absolute path to the host-owned JSON configuration below. |
| `GITHUB_CONTRIBUTIONS_STATE_FILE` | `~/.config/ai-assistant/github-contributions.json` | Persistent contribution ownership, branch/commit IDs, and recovery state. |
| `GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT` | `20` | Publish attempts per response, including failures. Non-negative safe integer; `0` means unlimited. |
| `CODEX_REVIEW_LIMIT` | `20` | Server-side review attempts per PR, including failures, retained across turns/restarts. Non-negative safe integer; `0` means unlimited. Set identically on the assistant and reviewer. |

Unset or blank limits use `20`; invalid values stop enabled-service startup. These
settings are operator-controlled and cannot be overridden by a tool request or
repository instructions. Set them in the Compose `.env` or launching environment
and recreate both services. Shared sessions pick up updated instructions and
capabilities on their next turn. Changing a limit does not reset existing attempts.
Unlimited removes only the selected quota: access restrictions, other tool budgets,
timeouts, and the 5,000-record review history caps still apply.

The legacy empty admin-list fallback does not grant contribution access in
`granted` mode. Existing guild/user/role scopes still apply. Restart after changing
access configuration. Private `/ask`, scheduled, and ephemeral runs do not receive contribution
tools. A different participant in a shared thread cannot revise the original
requester's contribution; they can start their own.

Register two **private GitHub Apps**, with webhooks and OAuth user authorization
disabled:

1. **Publisher:** contents read, pull requests write, metadata read. Install only
   on the chosen upstream repositories.
2. **Writer:** contents write, metadata read. Install only on pre-created forks
   under a separate account. Disable Actions in those forks.

Do not grant administration, workflows, Actions, checks, statuses, secrets,
organization access, or a ruleset bypass. Dynamic fork creation is intentionally
not exposed. Repository names and numeric IDs must match the actual upstreams
and their forks. Only the two upstream names above are accepted.

Example host configuration (IDs are placeholders):

```json
{
  "publisher": {
    "app_id": 100,
    "installation_id": 101,
    "bot_login": "your-publisher-app[bot]",
    "private_key_file": "publisher.pem"
  },
  "writer": {
    "app_id": 200,
    "installation_id": 201,
    "private_key_file": "writer.pem"
  },
  "repositories": [
    {
      "upstream": "Rubiss-Projects/ai-assistant",
      "upstream_id": 300,
      "fork": "your-account/ai-assistant-contributions",
      "fork_id": 301
    }
  ]
}
```

Key paths resolve relative to the configuration file. Configuration, keys, and
state must remain outside the provider workspace, including symlink targets.
Store them in the assistant's private persistent volume or a read-only secrets
mount, accessible to the assistant UID. Never mount them in the browser helper or
commit them to either repository. Installations issue short-lived tokens scoped
to one repository and the exact required permissions; keys and tokens stay in the
bot host, never in tool responses, provider environments, or local Git config.

## Contribution behavior

- Begin pins the current upstream default-branch commit and returns its file tree.
  Reading files uses that pinned commit or the contribution's latest published
  commit. No repository code executes in the credential-holding host.
- Publishing accepts complete UTF-8 file contents or explicit deletions. It
  preserves unchanged files and executable modes and creates a host-generated
  `ai-assistant/<uuid>` branch in the fork and a draft upstream PR. Commit and PR
  identity come from the respective Apps, never the operator's personal login.
- Updates require the last returned `head_sha`. Changes made outside the bot
  stop publishing; the bot never force-pushes. It does not automatically rebase
  onto a moving upstream. Maintainers can update/review a PR, or the requester can
  close it and begin a fresh contribution.
- Closed/merged PRs cannot be revised. Begin resumes an open contribution for the
  same requester/session/repository; status records closure for quota accounting.
  Before denying a new publish at the active limit, the host checks that user's
  earlier PRs for closure, including contributions from unavailable conversations.
- Durable pending-commit state recovers interrupted branch writes. Status and
  resumed begin finish an already-requested pending branch write before returning
  its current head, unless the PR closed or the branch changed externally. If a response
  is lost, check status and retry with the returned head; an already-created PR is
  discovered instead of duplicated. Preserve the state file across deployments.
- Each response allows 200 file reads, 10 begin/resume calls, 10 status checks, and
  the configured publish attempts (default 20), plus 20 review reads, 20 server-review
  waits, 10 review replies, and 10 thread
  resolutions, with independent budgets. Exhausting reads cannot block
  publishing or checking an interrupted write. Results include `remaining_calls`
  (`null` means unlimited for that tool);
  stop calling an exhausted tool until the next user turn. Failed operations also
  consume their tool's budget. Reuse downloaded files instead of reading them again.
- Review budgets are ceilings, not targets. Stop after a completed current-head
  review has no remaining actionable findings. Repeated review requests for the
  same head/base reuse the result, even with `retry: true`; a genuine published fix
  queues a review of its new head. Do not create no-op commits or extra PRs to spend
  remaining quota or reset a budget.
- Limits are 30 files and 1 MB per publish, 200 KB per text file,
  5 unfinished published contributions and 10 starts/day per
  user, and 1,000 retained records per installation. An operator can archive old
  closed or never-published records without pending writes while the bot is stopped
  if the installation cap is reached. Repository inspection alone does not consume
  the five-contribution publishing quota; interrupted branch writes do.
- Each tool operation has a 100-second budget covering queueing, token minting,
  and all GitHub requests. Its cancellation reaches the host before the adapter's
  115-second transport timeout. After a timeout, check status before retrying:
  GitHub may already have accepted the last request before cancellation arrived.
- Workflow/automation files under `.github`, submodules, symlinks, credential
  paths, binary files, and recognizable private keys/GitHub tokens are rejected.
  This is not a complete secret scanner: review all proposed public content.
  Builds/tests stay in the provider's ordinary sandbox when possible, and the PR
  should state what was actually tested. The host does not run package installs,
  build scripts, shell commands, or arbitrary Git commands for contributions.

## Review discussions

Ask in the original contribution conversation: “Address the Codex findings,
reply with what changed, and resolve the threads you fixed.” The original
requester's contribution access is required, including for reading feedback.
Existing PRs can use these tools without recreating the contribution.

Contribution sessions receive the bundled
[`babysit-contribution` skill](../.agents/skills/babysit-contribution/SKILL.md),
adapted from OpenAI's `babysit-pr`. It follows feedback through fix, validation,
publish, reply, refreshed thread version, and confirmed resolution, then checks
the new head's review and CI. It hands off for the human buttons once ready,
or reports a specific blocker/budget limit. It does not run an indefinite watcher
inside a Discord turn or claim monitoring continues after the turn ends.

`github_contribution_checks` provides ten reads per turn of check runs and commit
statuses for the owned PR's exact published head, plus live base and mergeability.
These use public read-only GitHub endpoints, leaving App permissions unchanged.
Public rate limits, missing checks, and truncated responses are reported as
unavailable/unknown, never passing. Check summaries and links support diagnosis;
private job logs and Actions reruns still require a human. CI success and a clean
server review are separate requirements. The human action buttons independently
recheck their own authorization and merge/release requirements.

- Reviews returns 25 threads per page and a `next_cursor` for the next page.
  Each thread includes its published comments, resolution state, and
  `thread_version`. Pending reviews are excluded. Threads with more than 100
  comments are marked truncated and must be handled on GitHub.
- Reply posts only inside an existing unresolved review thread on the owned PR.
  The host attributes the message to AI Assistant and includes the current
  published commit. Replies are limited to 6,000 characters, checked for
  recognizable credentials, and cannot contain `@codex` commands. A repeated
  identical latest reply is returned without posting it again after a lost response.
- Resolve requires a newer published commit than the original finding and a
  latest reply from the publisher App explaining the fix at the current head.
  Refresh reviews after replying and provide that latest `thread_version`.
  The agent must assess whether the fix actually addresses the finding; a newer
  commit alone does not demonstrate correctness.
- Every write checks the stored PR identity, current head, thread membership,
  and feedback version. New or edited feedback, external branch changes, and
  closed PRs stop the operation. GitHub does not offer an atomic conditional
  thread mutation, so another actor can still change remote state between the
  final check and the write. The host serializes its own operations.

These tools use the publisher App's existing pull-requests-write permission;
credentials remain outside the provider environment. Review resolution is not
approval or merging. Codex automatic-review settings are separate, and the bot
does not enforce a cap on reviews independently triggered by Codex.

GitHub's PR-write permission includes more than these operations, so the host
exposes only the seven contribution tools and enforces ownership on every call.
The model bridge has no arbitrary API/comment, review-approval, merge, auto-merge, or
workflow-dispatch operation. Read-only personal connector behavior remains unchanged.

## Linked GitHub actions in Discord

Enable `AI_ASSISTANT_ENABLE_GITHUB_ACTIONS=true` alongside contributions and server
reviews. Set `GITHUB_USER_APP_CLIENT_ID` to a **separate GitHub App's Client ID**.
Keep the existing publisher/writer Apps and their permissions unchanged.

Configure the new App with device flow and expiring user tokens enabled, webhooks
disabled, and installation limited to the configured contribution repositories.
Repository permissions: Contents, Pull requests, and Actions read/write; Checks
and Commit statuses read-only; Metadata read-only (automatic). No private key,
client secret, administration permission, or ruleset bypass is needed. User
tokens can exercise only permissions held by both the App and the linked person.

Run `/github link` in a server conversation. The bot privately gives the requester
a code to enter at `https://github.com/login/device`. After authorizing, click
**Finish linking**, verify the displayed GitHub login, then click the desired PR
action. Linking never resumes an earlier approval/merge/release automatically.
`/github status` shows the linked identity and refreshes this conversation's cards;
`/github unlink` deletes that person's local tokens and pending link. To revoke the
grant at GitHub as well, remove the App under GitHub Settings → Applications.

Each button uses only the clicking Discord user's linked account. Missing,
expired, or revoked authorization never falls back to an operator or App token.
One GitHub account cannot be linked to multiple Discord users. Contributors may
submit approvals under their own identities; those reviews are informational
unless they meet GitHub's required-review rules. They do not authorize a merge or
release. Explicit bot administrators and rights grants control `github.merge`
and `github.release` separately; chat access, the contributor/server-admin presets,
and the legacy open-admin fallback do not grant these capabilities. For example:

```json
{"grants":[{"guildId":"123","roleId":"456","capabilities":["github.merge","github.release"]}]}
```

Cards appear after Discord turns that have published bot contributions. They bind
the repository, PR, contribution, conversation, head and reviewed base. Every
click refreshes membership/rights and GitHub state. Ready for review, approve, and merge require a
completed clean server review, successful checks, and resolved threads; large
review histories fail closed. A changed revision requires a new card and review.
Merge checks repository write access and GitHub merge requirements and uses rebase
with the expected head SHA. If GitHub does not require approval, the authorized
maintainer must personally approve that revision first. The model never receives
these mutation tools or credentials.

Use **Ready for review** on a PR card or `/github ready repository:<repository> pull:<number>`
to take a draft PR out of draft without approving or merging it. This requires
`github.contribute` and repository write access through the user's linked GitHub
account. The command only accepts available bot contributions in the current
conversation. Repeated requests reconcile the current state without repeating an
uncertain mutation.

Successful PR actions post a public confirmation in the same conversation naming
the Discord user and linking the PR, such as “@user approved PR #123 ✅” or
“@user updated PR #123 ready for review 👍”. Release confirmations report that a
release was requested; the card tracks publication separately. Linking, account
status, errors, and refresh acknowledgments remain private. If public delivery
fails, a private response reports the GitHub result and the delivery failure.

After merging an AI Assistant PR, **Refresh** prepares the next patch version and
attaches a summary of all commits since the latest stable release. **Cut release**
publishes the displayed commit through the fixed `release.yml` workflow on `main`.
The merged commit's CI must pass; a moving main or changed preceding release
requires reassessment. Release publication also updates `latest`. It does not
deploy the running installation; the Docker promotion PR is separate. Manual
workflow dispatch now requires both `tag` and `expected_sha`; tag-push releases
continue to work. The workflow independently validates the selected commit and
refuses to rebuild an already published release.

The host persists action receipts before writes, reconciles lost approval/merge
responses, and polls release runs across restarts. Ambiguous writes are never
blindly repeated; if a release run cannot be uniquely identified, the card needs
operator investigation in GitHub Actions. A failed publication stops promotion.
Retries of a failed release workflow are an operator action, not a new release
button click. GitHub does not support an atomic comparison of a PR's base SHA at
merge; strict required checks on the target branch remain the protection against
a base changing concurrently with the final merge call.

`GITHUB_ACTIONS_STATE_DIR` defaults to `~/.config/ai-assistant/github-actions` and
must be outside the provider workspace. Tokens are encrypted with AES-256-GCM;
the owner-only directory contains `accounts.json`, its `token-key`, and `cards.json`.
Back up all three privately. The encryption key must remain accessible only to
the host; encryption does not protect against compromise of that host. Codes are
ephemeral Discord responses and never enter model prompts. Logs omit OAuth data.
Restarting abandons unfinished device links, while completed links and action
receipts survive. Storage is bounded to 1,000 linked users and 1,000 cards; archive
old terminal history during operator maintenance if capacity is reached.

## Rollout and rollback

Provision the protected configuration and keys before enabling the feature.
Start with Actions disabled on the forks, verify App installation selection,
then deploy the image and enable the flag/access mode. The app validates local
configuration at startup and repository identity before publishing. Monitor
`[github-contribution]` logs, which contain IDs and PR numbers, not content or
credentials. Back up the state file along with the existing bot data.

To disable contributions, set the feature flag to `false` and restart. Remove
the Apps' selected repository grants or suspend their installations to revoke
GitHub access immediately. Existing PRs remain for human review. Preserve the
state file and keys for an intentional re-enable; do not reset ownership while
old bot branches/PRs remain in use. This feature does not migrate session storage.

