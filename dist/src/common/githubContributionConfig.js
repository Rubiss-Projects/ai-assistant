import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuredWorkspaceRoot, pathIsWithin, sharedSecurityEnabled } from "./providerSecurity.js";
export function githubContributionsEnabled(env = process.env) {
    const value = env.AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS?.trim().toLowerCase() || "false";
    if (!["true", "false"].includes(value))
        throw new Error("AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS must be true or false.");
    if (value === "true" && !sharedSecurityEnabled(env))
        throw new Error("GitHub contributions require shared security mode.");
    return value === "true";
}
export function githubContributionAccess(env = process.env) {
    const value = env.GITHUB_CONTRIBUTIONS_ACCESS?.trim().toLowerCase() || "granted";
    if (value !== "chat" && value !== "granted")
        throw new Error("GITHUB_CONTRIBUTIONS_ACCESS must be chat or granted.");
    return value;
}
export function hostOnlyGitHubPath(file, env = process.env) {
    const root = configuredWorkspaceRoot(env);
    if (!root || !path.isAbsolute(file))
        throw new Error("GitHub storage requires an absolute host path and shared workspace root.");
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) || pathIsWithin(root, file)) {
        throw new Error("GitHub credentials and contribution state must be outside the provider workspace, including symlink targets.");
    }
    return file;
}
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid GitHub contribution configuration.");
    return value;
}
function positiveId(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw new Error("GitHub IDs must be positive integers.");
    return value;
}
function repositoryName(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value))
        throw new Error("Invalid GitHub repository name.");
    return value;
}
/** Configuration is host-owned; models select an allowlisted name, never a credential or URL. */
export function loadGitHubContributionConfiguration(env = process.env) {
    if (!githubContributionsEnabled(env))
        throw new Error("GitHub contributions are disabled.");
    githubContributionAccess(env);
    const file = hostOnlyGitHubPath(env.GITHUB_CONTRIBUTIONS_CONFIG_FILE?.trim() || "", env);
    const raw = object(JSON.parse(fs.readFileSync(file, "utf8")));
    const app = (value) => {
        const item = object(value);
        if (typeof item.private_key_file !== "string")
            throw new Error("A GitHub App private key file is required.");
        const keyFile = hostOnlyGitHubPath(path.resolve(path.dirname(file), item.private_key_file), env);
        if (!fs.statSync(keyFile).isFile())
            throw new Error("GitHub App key must be a regular file.");
        return { appId: positiveId(item.app_id), installationId: positiveId(item.installation_id), keyFile };
    };
    if (!Array.isArray(raw.repositories) || raw.repositories.length < 1 || raw.repositories.length > 2)
        throw new Error("Configure one or two contribution repositories.");
    const repositories = raw.repositories.map(value => {
        const item = object(value);
        const upstream = repositoryName(item.upstream);
        const fork = repositoryName(item.fork);
        if (!["Rubiss-Projects/ai-assistant", "Rubiss-Projects/docker"].includes(upstream))
            throw new Error("Unsupported contribution upstream.");
        if (upstream.split("/")[0].toLowerCase() === fork.split("/")[0].toLowerCase())
            throw new Error("Contribution forks must have a separate owner.");
        return { upstream, fork, upstreamId: positiveId(item.upstream_id), forkId: positiveId(item.fork_id) };
    });
    if (new Set(repositories.flatMap(repo => [repo.upstreamId, repo.forkId])).size !== repositories.length * 2)
        throw new Error("GitHub repository IDs must be distinct.");
    if (new Set(repositories.map(repo => repo.upstream)).size !== repositories.length)
        throw new Error("Duplicate contribution repository.");
    const publisher = app(raw.publisher);
    const writer = app(raw.writer);
    const publisherBotLogin = object(raw.publisher).bot_login;
    if (typeof publisherBotLogin !== "string" || !/^[a-z0-9-]+\[bot\]$/.test(publisherBotLogin))
        throw new Error("Configure the publisher bot_login.");
    if (publisher.appId === writer.appId || publisher.installationId === writer.installationId)
        throw new Error("Publisher and writer must use separate GitHub Apps.");
    const stateFile = hostOnlyGitHubPath(env.GITHUB_CONTRIBUTIONS_STATE_FILE?.trim()
        || path.join(os.homedir(), ".config", "ai-assistant", "github-contributions.json"), env);
    return { publisher, writer, publisherBotLogin, repositories, stateFile };
}
