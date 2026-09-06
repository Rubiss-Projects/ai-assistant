# Dependabot auto-merge

Dependabot pull requests are approved with `GITHUB_TOKEN` and queued for rebase
auto-merge, subject to the repository's required checks and branch rules.

Changes under `.github/workflows/` need a separate merge credential because
`GITHUB_TOKEN` cannot receive the Workflows permission. Without it, GitHub can
accept the auto-merge request and then disable it when checks finish.

Create a fine-grained personal access token with resource owner
`Rubiss-Projects`, access only to `ai-assistant`, and these repository permissions:

- Contents: Read and write
- Pull requests: Read and write
- Workflows: Read and write

The token owner must have write access to this repository. Complete any required
organization approval before using the token, and rotate it before it expires.
Store it as `DEPENDABOT_AUTOMERGE_TOKEN` under **Settings → Secrets and variables →
Dependabot**. An Actions-only secret is not available to these `pull_request`
runs started by Dependabot. With the token in a local environment variable, it
can also be installed without printing it:

```bash
printf '%s' "$DEPENDABOT_AUTOMERGE_TOKEN" | gh secret set DEPENDABOT_AUTOMERGE_TOKEN \
  --app dependabot --repo Rubiss-Projects/ai-assistant
```

The workflow uses this token only to merge PRs that change workflow files.
Other dependency updates continue to use `GITHUB_TOKEN`. It does not check out
or execute code from the pull request. Missing credentials fail the workflow
explicitly before approval or auto-merge is attempted.

After configuring or rotating the secret, rerun the failed Dependabot workflow.
For an existing PR whose original workflow run succeeded but auto-merge was
disabled, a new Dependabot branch update or reopening the PR will run the updated
workflow after this fix is merged. A manual merge can instead use a GitHub CLI
credential with the `workflow` scope in addition to `repo`.
