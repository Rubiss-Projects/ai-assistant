# GitHub contributions

Authorized Discord users can ask the assistant to propose a change to
`Rubiss-Projects/ai-assistant` or `Rubiss-Projects/docker`, then revise the resulting
draft pull request in the same conversation. For example: “Implement a clearer
error message for missing attachments and open a draft PR in AI Assistant.”
Maintainers review, mark ready, and merge on GitHub. The bot cannot approve,
merge, or enable auto-merge. Existing Dependabot workflows and branch rules do
not need to change.

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
- Durable pending-commit state recovers interrupted branch writes. Status and
  resumed begin finish an already-requested pending branch write before returning
  its current head, unless the PR closed or the branch changed externally. If a response
  is lost, check status and retry with the returned head; an already-created PR is
  discovered instead of duplicated. Preserve the state file across deployments.
- Limits are 30 files and 1 MB per publish, 200 KB per text file, 3 publishes and
  40 tool calls per response, 5 unfinished contributions and 10 starts/day per
  user, and 1,000 retained records per installation. An operator can archive old
  closed records while the bot is stopped if the installation cap is reached.
- Workflow/automation files under `.github`, submodules, symlinks, credential
  paths, binary files, and recognizable private keys/GitHub tokens are rejected.
  This is not a complete secret scanner: review all proposed public content.
  Builds/tests stay in the provider's ordinary sandbox when possible, and the PR
  should state what was actually tested. The host does not run package installs,
  build scripts, shell commands, or arbitrary Git commands for contributions.

GitHub's PR-write permission includes more than PR creation, so the host API
exposes only the four contribution operations and enforces ownership on every
call. It has no arbitrary API, review, merge, auto-merge, or workflow-dispatch
operation. Read-only personal connector behavior remains unchanged.

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
