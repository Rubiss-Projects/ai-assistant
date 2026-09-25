import fs from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { operationSignal } from "./operationSignal.js";
export class GitHubRequestError extends Error {
    status;
    constructor(status) {
        super(`GitHub operation failed (HTTP ${status}). Retry after checking repository access and contribution status.`);
        this.status = status;
    }
}
/** No redirects, arbitrary hosts, user tokens, subprocesses, or credentials in returned errors. */
export class GitHubContributionApi {
    config;
    fetcher;
    keys;
    tokens = new Map();
    constructor(config, fetcher = fetch) {
        this.config = config;
        this.fetcher = fetcher;
        this.keys = { publisher: createPrivateKey(fs.readFileSync(config.publisher.keyFile)), writer: createPrivateKey(fs.readFileSync(config.writer.keyFile)) };
    }
    async send(token, method, endpoint, body, signal, beforeSend) {
        signal.throwIfAborted();
        const operation = operationSignal(signal, 30_000, "GitHub request timed out.");
        try {
            const options = {
                method, redirect: "error", signal: operation.signal,
                headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2026-03-10" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            };
            operation.signal.throwIfAborted();
            beforeSend?.();
            const response = await this.fetcher(`https://api.github.com${endpoint}`, options);
            if (!response.ok) {
                await response.body?.cancel();
                throw new GitHubRequestError(response.status);
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body ?? []) {
                size += chunk.byteLength;
                if (size > 8_000_000) {
                    throw new Error("GitHub response exceeds the contribution size limit.");
                }
                chunks.push(chunk);
            }
            return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        }
        finally {
            operation.dispose();
        }
    }
    jwt(role, app) {
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: app.appId, iat: now - 60, exp: now + 540 })}`;
        return `${data}.${sign("RSA-SHA256", Buffer.from(data), this.keys[role]).toString("base64url")}`;
    }
    async authenticated(role, repository, method, endpoint, body, signal, beforeSend) {
        const app = this.config[role];
        const repositoryId = role === "publisher" ? repository.upstreamId : repository.forkId;
        const key = `${role}:${repositoryId}`;
        let token = this.tokens.get(key);
        if (!token || token.expires < Date.now() + 60_000) {
            const permissions = role === "publisher" ? { contents: "read", pull_requests: "write" } : { contents: "write" };
            const minted = await this.send(this.jwt(role, app), "POST", `/app/installations/${app.installationId}/access_tokens`, { repository_ids: [repositoryId], permissions }, signal);
            if (minted.repositories?.length !== 1 || minted.repositories[0].id !== repositoryId
                || Object.entries(minted.permissions).some(([name, access]) => name === "metadata" ? access !== "read" : permissions[name] !== access)
                || typeof minted.token !== "string" || !Number.isFinite(Date.parse(minted.expires_at)))
                throw new Error("GitHub returned an unexpected token scope.");
            token = { value: minted.token, expires: Date.parse(minted.expires_at) };
            this.tokens.set(key, token);
        }
        try {
            return await this.send(token.value, method, endpoint, body, signal, beforeSend);
        }
        catch (error) {
            if (error instanceof GitHubRequestError && error.status === 401)
                this.tokens.delete(key);
            throw error; // No automatic mutation retries: the broker reconciles remote state first.
        }
    }
    request(role, repository, method, suffix, body, signal, beforeSend) {
        const name = role === "publisher" ? repository.upstream : repository.fork;
        return this.authenticated(role, repository, method, `/repos/${name}${suffix}`, body, signal, beforeSend);
    }
    /** Only host-owned review documents reach this transport; no query is accepted from tools. */
    async graphql(repository, query, variables, signal) {
        const response = await this.authenticated("publisher", repository, "POST", "/graphql", { query, variables }, signal);
        if (response.errors?.length || !response.data)
            throw new Error("GitHub review operation failed. Refresh the contribution reviews before retrying.");
        return response.data;
    }
}
