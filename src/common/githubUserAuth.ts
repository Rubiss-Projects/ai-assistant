import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { githubContributionsEnabled, hostOnlyGitHubPath } from "./githubContributionConfig.js";

export class GitHubActionError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export interface GitHubUser { id: number; login: string }
interface Account extends GitHubUser { generation: string; access: string; refresh: string; expires: number; refreshExpires: number }
interface Device { id: string; code: string; expires: number; nextPoll: number; interval: number }
export interface UserGitHubClient {
  user: GitHubUser;
  request<T>(method: "GET" | "POST" | "PUT", endpoint: string, body?: unknown): Promise<T>;
}

export function githubActionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AI_ASSISTANT_ENABLE_GITHUB_ACTIONS?.trim() || "false";
  if (!["true", "false"].includes(value)) throw new Error("AI_ASSISTANT_ENABLE_GITHUB_ACTIONS must be true or false.");
  if (value === "true" && !githubContributionsEnabled(env)) throw new Error("GitHub actions require shared-mode contributions.");
  return value === "true";
}

export function githubActionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return hostOnlyGitHubPath(env.GITHUB_ACTIONS_STATE_DIR?.trim() || path.join(os.homedir(), ".config", "ai-assistant", "github-actions"), env);
}

/** Atomic, owner-only storage, always outside the provider's readable workspace. */
export function writeGitHubState(file: string, value: unknown): void {
  hostOnlyGitHubPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** Bounded JSON transport. GitHub error bodies and OAuth values never reach logs or Discord. */
export async function githubJson<T>(fetcher: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubActionError(`GitHub rejected the request (HTTP ${response.status}). Check your linked account's access, then refresh the card.`, response.status);
  }
  if (response.status === 204) return undefined as T;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > 2_000_000) throw new GitHubActionError("GitHub's response exceeded the action limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/** One Discord user selects exactly one account. There is deliberately no operator-token fallback. */
export class GitHubUserAuth {
  private readonly accounts: Record<string, Account>;
  private readonly pending = new Map<string, Device>();
  private readonly refreshing = new Map<string, Promise<Account>>();
  private readonly key: Buffer;
  private readonly file: string;
  constructor(private readonly clientId: string, directory = githubActionDirectory(), private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    if (!/^[A-Za-z0-9_.-]{10,100}$/.test(clientId)) throw new Error("Configure GITHUB_USER_APP_CLIENT_ID for a GitHub App with device flow enabled.");
    hostOnlyGitHubPath(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyFile = hostOnlyGitHubPath(path.join(directory, "token-key"));
    this.file = hostOnlyGitHubPath(path.join(directory, "accounts.json"));
    if (!fs.existsSync(keyFile)) {
      if (fs.existsSync(this.file)) throw new Error("GitHub account encryption key is missing. Restore it before starting.");
      fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error("Invalid GitHub account encryption key.");
    this.accounts = {};
    if (fs.existsSync(this.file)) {
      const envelope = JSON.parse(fs.readFileSync(this.file, "utf8")) as { iv: string; tag: string; ciphertext: string };
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(clientId));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const records = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")) as Record<string, Account>;
      if (!records || Array.isArray(records) || Object.keys(records).length > 1000 || Object.entries(records).some(([id, a]) =>
        !/^\d+$/.test(id) || !a || !Number.isSafeInteger(a.id) || !a.login || !a.generation || !a.access || !a.refresh || !Number.isFinite(a.expires) || !Number.isFinite(a.refreshExpires))) throw new Error("Invalid linked GitHub account store.");
      Object.assign(this.accounts, records);
    }
  }
  private save() {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(this.clientId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.accounts)), cipher.final()]);
    writeGitHubState(this.file, { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  }
  linked(userId: string): GitHubUser | undefined {
    const account = this.accounts[userId];
    return account ? { id: account.id, login: account.login } : undefined;
  }
  unlink(userId: string): void { this.pending.delete(userId); delete this.accounts[userId]; this.save(); }
  private oauth(body: Record<string, string>, signal: AbortSignal, device = false) {
    return githubJson<Record<string, unknown>>(this.fetcher, `https://github.com/login/${device ? "device/code" : "oauth/access_token"}`, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: this.clientId, ...body }),
    }, signal);
  }
  async begin(userId: string, signal: AbortSignal) {
    if (!/^\d+$/.test(userId)) throw new GitHubActionError("Invalid Discord identity.");
    for (const [id, pending] of this.pending) if (pending.expires <= this.now()) this.pending.delete(id);
    if (this.pending.has(userId)) throw new GitHubActionError("A link is already pending. Use Finish linking, or /github unlink to start again.");
    if (this.pending.size >= 100 || (!this.accounts[userId] && Object.keys(this.accounts).length >= 1000)) throw new GitHubActionError("GitHub linking is at capacity. Try again later.");
    // Reserve before the network wait to prevent parallel requests creating multiple grants.
    const pending: Device = { id: randomUUID(), code: "", expires: this.now() + 30_000, nextPoll: Infinity, interval: 5000 };
    this.pending.set(userId, pending);
    try {
      const result = await this.oauth({}, signal, true);
      if (this.pending.get(userId) !== pending) throw new GitHubActionError("Linking was cancelled.");
      if (typeof result.device_code !== "string" || typeof result.user_code !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(result.user_code)
        || result.verification_uri !== "https://github.com/login/device" || typeof result.expires_in !== "number" || result.expires_in <= 0 || result.expires_in > 900
        || typeof result.interval !== "number" || result.interval < 1 || result.interval > 60) throw new GitHubActionError("GitHub device linking is unavailable. Check the App's device-flow setting.");
      Object.assign(pending, { code: result.device_code, expires: this.now() + result.expires_in * 1000, interval: result.interval * 1000, nextPoll: this.now() + result.interval * 1000 });
      return { id: pending.id, code: result.user_code };
    } catch (error) { if (this.pending.get(userId) === pending) this.pending.delete(userId); throw error; }
  }
  private token(result: Record<string, unknown>) {
    if (typeof result.access_token !== "string" || !result.access_token.startsWith("ghu_") || typeof result.refresh_token !== "string" || !result.refresh_token.startsWith("ghr_")
      || typeof result.expires_in !== "number" || result.expires_in <= 0 || typeof result.refresh_token_expires_in !== "number" || result.refresh_token_expires_in <= 0) {
      throw new GitHubActionError("GitHub authorization could not be completed. Enable expiring user tokens and link again.");
    }
    return { access: result.access_token, refresh: result.refresh_token, expires: this.now() + result.expires_in * 1000, refreshExpires: this.now() + result.refresh_token_expires_in * 1000 };
  }
  private async identity(token: string, signal: AbortSignal): Promise<GitHubUser> {
    const user = await this.api<GitHubUser>(token, "GET", "/user", signal);
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) throw new GitHubActionError("GitHub returned an invalid account identity.");
    return { id: user.id, login: user.login };
  }
  async finish(userId: string, id: string, signal: AbortSignal): Promise<GitHubUser | undefined> {
    const pending = this.pending.get(userId);
    if (!pending || pending.id !== id || pending.expires <= this.now()) throw new GitHubActionError("This link expired or belongs to another person. Start /github link again.");
    if (pending.nextPoll > this.now()) throw new GitHubActionError("Please wait a few seconds before checking the link again.");
    pending.nextPoll = Infinity;
    try {
      const result = await this.oauth({ device_code: pending.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, signal);
      if (result.error === "slow_down") pending.interval += 5000;
      if (result.error === "authorization_pending" || result.error === "slow_down") return undefined;
      if (result.error) { this.pending.delete(userId); throw new GitHubActionError("GitHub linking expired or was declined. Start /github link again."); }
      const token = this.token(result);
      const user = await this.identity(token.access, signal);
      if (this.pending.get(userId) !== pending) throw new GitHubActionError("Linking was cancelled.");
      if (Object.entries(this.accounts).some(([id, account]) => id !== userId && account.id === user.id)) throw new GitHubActionError("That GitHub account is already linked to another Discord user.");
      this.accounts[userId] = { ...user, ...token, generation: randomUUID() };
      this.save(); this.pending.delete(userId);
      return user;
    } finally { pending.nextPoll = this.now() + pending.interval; }
  }
  private api<T>(token: string, method: string, endpoint: string, signal: AbortSignal, body?: unknown) {
    if (!/^\/(?:user$|repos\/|graphql$)/.test(endpoint) || endpoint.includes("..") || endpoint.includes("\\")) throw new Error("Invalid host GitHub endpoint.");
    return githubJson<T>(this.fetcher, `https://api.github.com${endpoint}`, { method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2026-03-10" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, signal);
  }
  private async current(userId: string, signal: AbortSignal): Promise<Account> {
    const account = this.accounts[userId];
    if (!account) throw new GitHubActionError("Link your own GitHub account with /github link first.");
    if (account.expires > this.now() + 60_000) return account;
    let refreshing = this.refreshing.get(userId);
    if (!refreshing) {
      refreshing = (async () => {
        if (account.refreshExpires <= this.now()) throw new GitHubActionError("Your GitHub authorization expired. Link your account again.");
        const token = this.token(await this.oauth({ grant_type: "refresh_token", refresh_token: account.refresh }, signal));
        if (this.accounts[userId] !== account) throw new GitHubActionError("Your GitHub link changed during this action.");
        const user = await this.identity(token.access, signal);
        if (user.id !== account.id || this.accounts[userId] !== account) throw new GitHubActionError("Your GitHub identity changed. Link again.");
        const updated = { ...account, ...user, ...token };
        this.accounts[userId] = updated; this.save(); return updated;
      })();
      this.refreshing.set(userId, refreshing);
      void refreshing.finally(() => { if (this.refreshing.get(userId) === refreshing) this.refreshing.delete(userId); }).catch(() => {});
    }
    return refreshing;
  }
  async client(userId: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<UserGitHubClient> {
    await authorize();
    const account = await this.current(userId, signal);
    const user = await this.identity(account.access, signal);
    if (user.id !== account.id) throw new GitHubActionError("Your GitHub identity changed. Link again.");
    return { user, request: async <T>(method: "GET" | "POST" | "PUT", endpoint: string, body?: unknown) => {
      const current = await this.current(userId, signal);
      await authorize();
      if (current.generation !== account.generation || this.accounts[userId]?.generation !== account.generation) throw new GitHubActionError("Your GitHub link changed. Refresh before acting.");
      signal.throwIfAborted();
      return this.api<T>(current.access, method, endpoint, signal, body);
    } };
  }
}
