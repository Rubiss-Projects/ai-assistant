import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitHubContributionApi, GitHubRequestError } from "./githubContributionApi.js";
import { githubContributionsEnabled, hostOnlyGitHubPath, loadGitHubContributionConfiguration } from "./githubContributionConfig.js";
function rejectCredentials(text) {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/.test(text))
        throw new Error("Potential credentials detected; remove them before publishing.");
}
function sha(value) {
    if (!/^[0-9a-f]{40}$/.test(value))
        throw new Error("GitHub returned an invalid commit identifier.");
    return value;
}
export function validateContributionPath(value, writable = false) {
    if (typeof value !== "string" || value.length > 240 || /[\\\x00-\x1f\x7f]/.test(value)
        || value.split("/").some(segment => !segment || segment === "." || segment === ".."))
        throw new Error("Use a relative repository file path without traversal.");
    const segments = value.toLowerCase().split("/");
    if (segments.includes(".git") || segments.includes("node_modules") || segments.includes(".ssh") || segments.includes(".codex")
        || segments.some(segment => segment === ".env" || (segment.startsWith(".env.") && segment !== ".env.example"))
        || /(?:^|\/)(?:auth\.json|\.netrc|\.npmrc|\.git-credentials)$|\.(?:pem|key|p12|pfx)$/i.test(value)
        || (writable && segments.some(segment => segment === ".github" || segment === ".gitmodules"))) {
        throw new Error("Credential paths and GitHub automation files cannot be contributed through this tool.");
    }
    return value;
}
export function validateContributionChanges(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 30)
        throw new Error("Publish between 1 and 30 text-file changes.");
    let bytes = 0;
    const seen = new Set();
    return value.map(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid file change.");
        const change = raw;
        if (Object.keys(change).some(key => !["path", "content"].includes(key)))
            throw new Error("Only path and content are accepted for file changes.");
        const file = validateContributionPath(change.path, true);
        if ([...seen].some(other => other === file.toLowerCase() || other.startsWith(`${file.toLowerCase()}/`) || file.toLowerCase().startsWith(`${other}/`)))
            throw new Error("Duplicate, overlapping, or case-conflicting file changes.");
        seen.add(file.toLowerCase());
        if (change.content !== null && typeof change.content !== "string")
            throw new Error("Content must be UTF-8 text, or null to delete a file.");
        if (typeof change.content === "string") {
            bytes += Buffer.byteLength(change.content);
            if (Buffer.byteLength(change.content) > 200_000 || bytes > 1_000_000 || change.content.includes("\0"))
                throw new Error("Contribution text exceeds the size limit or contains binary data.");
            rejectCredentials(change.content);
        }
        return { path: file, content: change.content };
    });
}
/** Durable ownership and pending commits survive timeouts/restarts without duplicate PRs. */
export class GitHubContributions {
    config;
    api;
    records;
    queue = Promise.resolve();
    constructor(config, api = new GitHubContributionApi(config)) {
        this.config = config;
        this.api = api;
        hostOnlyGitHubPath(config.stateFile);
        this.records = fs.existsSync(config.stateFile) ? JSON.parse(fs.readFileSync(config.stateFile, "utf8")) : [];
        if (!Array.isArray(this.records) || this.records.length > 1000 || this.records.some(record => !record || !/^[0-9a-f-]{36}$/.test(record.id) || record.branch !== `ai-assistant/${record.id}`
            || typeof record.session !== "string" || typeof record.user !== "string" || !this.config.repositories.some(repo => repo.upstream === record.repository))) {
            throw new Error("Invalid contribution state; restore the host-owned state file before enabling contributions.");
        }
    }
    authorize(caller) {
        caller.signal.throwIfAborted();
        if (!githubContributionsEnabled() || !caller.access.can(caller.requester, "github.contribute"))
            throw new Error("You do not have access to GitHub contributions.");
    }
    save(record) {
        hostOnlyGitHubPath(this.config.stateFile);
        const records = [...this.records.filter(item => item.id !== record.id), record];
        fs.mkdirSync(path.dirname(this.config.stateFile), { recursive: true, mode: 0o700 });
        const temporary = `${this.config.stateFile}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(records), { mode: 0o600, flag: "wx" });
            fs.renameSync(temporary, this.config.stateFile);
        }
        finally {
            fs.rmSync(temporary, { force: true });
        }
        this.records = records;
    }
    owned(caller, id) {
        const record = this.records.find(item => item.id === id);
        if (!record || record.session !== caller.session || record.user !== caller.requester.userId || record.guild !== (caller.requester.guildId ?? null)) {
            throw new Error("Contribution belongs to another Discord requester or session, or no longer exists.");
        }
        return { ...record };
    }
    repository(name) {
        const repository = this.config.repositories.find(repo => repo.upstream === name);
        if (!repository)
            throw new Error("Choose an enabled contribution repository.");
        return repository;
    }
    request(caller, repository, role, method, suffix, body) {
        this.authorize(caller); // Recheck before every remote operation, including after network waits.
        return this.api.request(role, repository, method, suffix, body, caller.signal);
    }
    async verify(caller, repository) {
        const upstream = await this.request(caller, repository, "publisher", "GET", "");
        const fork = await this.request(caller, repository, "writer", "GET", "");
        if (upstream.id !== repository.upstreamId || upstream.full_name !== repository.upstream || upstream.private || upstream.archived
            || fork.id !== repository.forkId || fork.full_name !== repository.fork || !fork.fork || fork.parent?.id !== upstream.id || fork.private || fork.archived) {
            throw new Error("Repository identity or fork relationship changed; operator configuration must be reviewed.");
        }
        return upstream;
    }
    serial(caller, action) {
        const operation = this.queue.catch(() => { }).then(() => { this.authorize(caller); return action(); });
        this.queue = operation;
        return operation;
    }
    async tree(caller, record) {
        const result = await this.request(caller, this.repository(record.repository), record.published ? "writer" : "publisher", "GET", `/git/trees/${sha(record.headSha)}?recursive=1`);
        if (result.truncated || result.tree.length > 10_000)
            throw new Error("Repository tree exceeds the contribution limit.");
        return result;
    }
    validatePull(record, pull) {
        const repository = this.repository(record.repository);
        if (pull.user.login !== this.config.publisherBotLogin || pull.head.repo?.id !== repository.forkId || pull.head.ref !== record.branch
            || pull.base.repo.id !== repository.upstreamId || pull.base.ref !== record.baseBranch)
            throw new Error("Pull request identity changed; refusing to modify it.");
    }
    async currentPull(caller, record) {
        const repository = this.repository(record.repository);
        if (record.pull) {
            const pull = await this.request(caller, repository, "publisher", "GET", `/pulls/${record.pull}`);
            this.validatePull(record, pull);
            return pull;
        }
        const pulls = await this.request(caller, repository, "publisher", "GET", `/pulls?state=all&head=${encodeURIComponent(`${repository.fork.split("/")[0]}:${record.branch}`)}&base=${encodeURIComponent(record.baseBranch)}&per_page=10`);
        if (pulls.length > 1)
            throw new Error("Multiple PRs reference this contribution; operator review is required.");
        if (pulls[0]) {
            this.validatePull(record, pulls[0]);
            record.pull = pulls[0].number;
            this.save(record);
        }
        return pulls[0];
    }
    async ref(caller, record) {
        try {
            return sha((await this.request(caller, this.repository(record.repository), "writer", "GET", `/git/ref/heads/${record.branch}`)).object.sha);
        }
        catch (error) {
            if (error instanceof GitHubRequestError && error.status === 404)
                return undefined;
            throw error;
        }
    }
    async recover(caller, record) {
        const current = await this.ref(caller, record);
        if (record.pendingSha) {
            if (current !== record.pendingSha) {
                if (current !== (record.published ? record.headSha : undefined))
                    throw new Error("Contribution branch changed outside this session; refusing to overwrite it.");
                await this.request(caller, this.repository(record.repository), "writer", current ? "PATCH" : "POST", current ? `/git/refs/heads/${record.branch}` : "/git/refs", current ? { sha: record.pendingSha, force: false } : { ref: `refs/heads/${record.branch}`, sha: record.pendingSha });
            }
            record.headSha = record.pendingSha;
            delete record.pendingSha;
            record.published = true;
            this.save(record);
        }
        else if (current !== (record.published ? record.headSha : undefined)) {
            throw new Error("Contribution branch changed outside this session; refusing to overwrite it.");
        }
    }
    summary(record) {
        return { contribution_id: record.id, repository: record.repository, base_branch: record.baseBranch, base_sha: record.baseSha, head_sha: record.headSha,
            pull_request_url: record.pull ? `https://github.com/${record.repository}/pull/${record.pull}` : undefined, closed: record.closed };
    }
    /** Reconcile an already-authorized publish before advertising a head for the next edit. */
    async refresh(caller, record) {
        const pull = record.published || record.pendingSha ? await this.currentPull(caller, record) : undefined;
        if (pull?.state === "closed") {
            record.closed = true;
            this.save(record);
        }
        if (!record.closed && record.pendingSha) {
            await this.verify(caller, this.repository(record.repository));
            await this.recover(caller, record);
            return this.currentPull(caller, record);
        }
        return pull;
    }
    begin(caller, repositoryName) {
        return this.serial(caller, async () => {
            const repository = this.repository(repositoryName);
            const upstream = await this.verify(caller, repository);
            let record = this.records.find(item => item.session === caller.session && item.user === caller.requester.userId && item.guild === (caller.requester.guildId ?? null) && item.repository === repositoryName && !item.closed);
            if (record) {
                record = { ...record };
                await this.refresh(caller, record);
                if (record.closed)
                    record = undefined;
            }
            if (!record) {
                const owned = this.records.filter(item => item.user === caller.requester.userId);
                if (owned.filter(item => item.createdAt > Date.now() - 86_400_000).length >= 10 || this.records.length >= 1000)
                    throw new Error("Contribution start limit reached. Wait for the daily limit or ask the operator to archive old records.");
                const base = await this.request(caller, repository, "publisher", "GET", `/git/ref/heads/${encodeURIComponent(upstream.default_branch)}`);
                const id = randomUUID();
                record = { id, session: caller.session, user: caller.requester.userId, guild: caller.requester.guildId ?? null, repository: repositoryName,
                    branch: `ai-assistant/${id}`, baseBranch: upstream.default_branch, baseSha: sha(base.object.sha), headSha: base.object.sha, published: false, closed: false, createdAt: Date.now() };
                this.save(record);
            }
            const tree = await this.tree(caller, record);
            return { ...this.summary(record), files: tree.tree.filter(entry => entry.type === "blob").map(entry => ({ path: entry.path, bytes: entry.size, mode: entry.mode })) };
        });
    }
    read(caller, id, file) {
        return this.serial(caller, async () => {
            const record = this.owned(caller, id);
            validateContributionPath(file);
            const tree = await this.tree(caller, record);
            const entry = tree.tree.find(item => item.path === file);
            if (!entry || !["100644", "100755"].includes(entry.mode) || (entry.size ?? Infinity) > 200_000)
                throw new Error("Choose an existing regular text file under 200 KB.");
            const blob = await this.request(caller, this.repository(record.repository), record.published ? "writer" : "publisher", "GET", `/git/blobs/${sha(entry.sha)}`);
            if (blob.encoding !== "base64" || blob.size > 200_000)
                throw new Error("Unsupported GitHub file encoding or size.");
            const data = Buffer.from(blob.content, "base64");
            if (data.includes(0))
                throw new Error("Binary files are unsupported.");
            return { path: file, head_sha: record.headSha, content: new TextDecoder("utf-8", { fatal: true }).decode(data) };
        });
    }
    publish(caller, id, expectedHead, title, body, changes) {
        return this.serial(caller, async () => {
            const record = this.owned(caller, id);
            const repository = this.repository(record.repository);
            if (!record.published && !record.pendingSha && this.records.filter(item => item.user === record.user && !item.closed && (item.published || item.pendingSha)).length >= 5) {
                throw new Error("Five unfinished published contributions are already open. Close completed PRs and check their status before publishing another.");
            }
            if (!title.trim() || title.length > 160 || /[\r\n]/.test(title) || body.length > 12_000)
                throw new Error("Use a one-line title under 160 characters and a description under 12,000 characters.");
            rejectCredentials(title);
            rejectCredentials(body);
            validateContributionChanges(changes);
            await this.verify(caller, repository);
            const pull = record.published ? await this.currentPull(caller, record) : undefined;
            if (record.closed || pull?.state === "closed") {
                record.closed = true;
                this.save(record);
                throw new Error("This contribution is closed. Start a new contribution.");
            }
            await this.recover(caller, record);
            if (sha(expectedHead) !== record.headSha)
                throw new Error("Contribution head changed. Read the current files and retry with the returned head_sha.");
            const tree = await this.tree(caller, record);
            for (const change of changes) {
                const entry = tree.tree.find(item => item.path === change.path);
                if (entry && !["100644", "100755"].includes(entry.mode))
                    throw new Error("Symlinks, directories, and submodules cannot be changed.");
                if (!entry && change.content === null)
                    throw new Error("Cannot delete a missing file.");
                if (tree.tree.some(item => change.path.startsWith(`${item.path}/`) && item.type !== "tree"))
                    throw new Error("A parent path is not a directory.");
            }
            const createdTree = await this.request(caller, repository, "writer", "POST", "/git/trees", { base_tree: sha(tree.sha), tree: changes.map(change => ({
                    path: change.path, mode: tree.tree.find(item => item.path === change.path)?.mode ?? "100644", type: "blob",
                    ...(change.content === null ? { sha: null } : { content: change.content }),
                })) });
            if (createdTree.sha !== tree.sha) {
                const commit = await this.request(caller, repository, "writer", "POST", "/git/commits", { message: title, tree: sha(createdTree.sha), parents: [record.headSha] });
                record.pendingSha = sha(commit.sha);
                this.save(record);
                await this.recover(caller, record);
            }
            if (!record.published)
                throw new Error("No file changes to publish.");
            const description = `${body.trim()}\n\n---\nContributed through AI Assistant using its dedicated GitHub Apps. Requires maintainer review and merge.`;
            const existing = pull ?? await this.currentPull(caller, record);
            const published = await this.request(caller, repository, "publisher", existing ? "PATCH" : "POST", existing ? `/pulls/${existing.number}` : "/pulls", existing
                ? { title, body: description, maintainer_can_modify: false }
                : { title, body: description, head: `${repository.fork.split("/")[0]}:${record.branch}`, base: record.baseBranch, draft: true, maintainer_can_modify: false });
            this.validatePull(record, published);
            record.pull = published.number;
            this.save(record);
            console.info(`[github-contribution] published id=${record.id} repository=${record.repository} pr=${record.pull}`);
            return { ...this.summary(record), draft: published.draft };
        });
    }
    status(caller, id) {
        return this.serial(caller, async () => {
            const record = this.owned(caller, id);
            const pull = await this.refresh(caller, record);
            return { ...this.summary(record), draft: pull?.draft, state: pull?.state ?? "local", merged: pull?.merged ?? false, pending_publish: Boolean(record.pendingSha), remote_head_sha: pull?.head.sha };
        });
    }
}
let configured;
export function githubContributionService() {
    if (!githubContributionsEnabled())
        throw new Error("GitHub contributions are disabled.");
    return configured ??= new GitHubContributions(loadGitHubContributionConfiguration());
}
