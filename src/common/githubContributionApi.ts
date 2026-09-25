import fs from "node:fs";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { operationSignal } from "./operationSignal.js";
import type { ContributionRepository, GitHubAppConfiguration, GitHubContributionConfiguration } from "./githubContributionConfig.js";

export type GitHubRole = "publisher" | "writer";
export interface ContributionApi {
  /** beforeSend runs synchronously after preflight, immediately before the repository fetch. */
  request<T>(role: GitHubRole, repository: ContributionRepository, method: "GET" | "POST" | "PATCH", suffix: string, body: unknown, signal: AbortSignal, beforeSend?: () => void): Promise<T>;
  graphql<T>(repository: ContributionRepository, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T>;
}
export class GitHubRequestError extends Error {
  constructor(readonly status: number) { super(`GitHub operation failed (HTTP ${status}). Retry after checking repository access and contribution status.`); }
}

/** No redirects, arbitrary hosts, user tokens, subprocesses, or credentials in returned errors. */
export class GitHubContributionApi implements ContributionApi {
  private readonly keys: Record<GitHubRole, KeyObject>;
  private readonly tokens = new Map<string, { value: string; expires: number }>();
  constructor(private readonly config: GitHubContributionConfiguration, private readonly fetcher: typeof fetch = fetch) {
    this.keys = { publisher: createPrivateKey(fs.readFileSync(config.publisher.keyFile)), writer: createPrivateKey(fs.readFileSync(config.writer.keyFile)) };
  }

  private async send<T>(token: string, method: string, endpoint: string, body: unknown, signal: AbortSignal, beforeSend?: () => void): Promise<T> {
    signal.throwIfAborted();
    const operation = operationSignal(signal, 30_000, "GitHub request timed out.");
    try {
      const options: RequestInit = {
        method, redirect: "error", signal: operation.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2026-03-10" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      operation.signal.throwIfAborted();
      beforeSend?.();
      const response = await this.fetcher(`https://api.github.com${endpoint}`, options);
      if (!response.ok) { await response.body?.cancel(); throw new GitHubRequestError(response.status); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > 8_000_000) { throw new Error("GitHub response exceeds the contribution size limit."); }
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } finally { operation.dispose(); }
  }

  private jwt(role: GitHubRole, app: GitHubAppConfiguration): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: app.appId, iat: now - 60, exp: now + 540 })}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), this.keys[role]).toString("base64url")}`;
  }

  private async authenticated<T>(role: GitHubRole, repository: ContributionRepository, method: string, endpoint: string, body: unknown, signal: AbortSignal, beforeSend?: () => void): Promise<T> {
    const app = this.config[role];
    const repositoryId = role === "publisher" ? repository.upstreamId : repository.forkId;
    const key = `${role}:${repositoryId}`;
    let token = this.tokens.get(key);
    if (!token || token.expires < Date.now() + 60_000) {
      const permissions = role === "publisher" ? { contents: "read", pull_requests: "write" } : { contents: "write" };
      const minted = await this.send<{ token: string; expires_at: string; repositories: { id: number }[]; permissions: Record<string, string> }>(
        this.jwt(role, app), "POST", `/app/installations/${app.installationId}/access_tokens`, { repository_ids: [repositoryId], permissions }, signal);
      if (minted.repositories?.length !== 1 || minted.repositories[0].id !== repositoryId
        || Object.entries(minted.permissions).some(([name, access]) => name === "metadata" ? access !== "read" : permissions[name as keyof typeof permissions] !== access)
        || typeof minted.token !== "string" || !Number.isFinite(Date.parse(minted.expires_at))) throw new Error("GitHub returned an unexpected token scope.");
      token = { value: minted.token, expires: Date.parse(minted.expires_at) };
      this.tokens.set(key, token);
    }
    try { return await this.send<T>(token.value, method, endpoint, body, signal, beforeSend); }
    catch (error) {
      if (error instanceof GitHubRequestError && error.status === 401) this.tokens.delete(key);
      throw error; // No automatic mutation retries: the broker reconciles remote state first.
    }
  }

  request<T>(role: GitHubRole, repository: ContributionRepository, method: "GET" | "POST" | "PATCH", suffix: string, body: unknown, signal: AbortSignal, beforeSend?: () => void): Promise<T> {
    const name = role === "publisher" ? repository.upstream : repository.fork;
    return this.authenticated<T>(role, repository, method, `/repos/${name}${suffix}`, body, signal, beforeSend);
  }

  /** Only host-owned review documents reach this transport; no query is accepted from tools. */
  async graphql<T>(repository: ContributionRepository, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const response = await this.authenticated<{ data?: T; errors?: unknown[] }>("publisher", repository, "POST", "/graphql", { query, variables }, signal);
    if (response.errors?.length || !response.data) throw new Error("GitHub review operation failed. Refresh the contribution reviews before retrying.");
    return response.data;
  }
}
