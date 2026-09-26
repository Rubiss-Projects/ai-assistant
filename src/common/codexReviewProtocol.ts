import { createHash } from "node:crypto";

export const REVIEW_SOCKET = "/review-control/review.sock";
export const REVIEW_MAX_BYTES = 16_000_000;
export const REVIEW_TIMEOUT_MS = 10 * 60_000;
export interface ReviewFile { path: string; content: string }
export interface ReviewChange { path: string; previousPath?: string; status: string; patch: string; additions: number; deletions: number }
export interface ReviewInput {
  id: string; repository: string; pull: number; head: string; base: string;
  files: ReviewFile[]; changes: ReviewChange[]; omitted: string[];
}
export interface ReviewFinding { priority: number; title: string; body: string; path: string; line: number }
export interface ReviewResult { summary: string; findings: ReviewFinding[] }
export interface ReviewJob {
  id: string; digest: string; repository: string; pull: number; head: string; base: string;
  state: "queued" | "running" | "completed" | "failed";
  result?: ReviewResult; error?: string;
}

export function reviewId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid review job ID.");
  return value;
}
export function reviewPath(value: string): string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z0-9_.@/ -]+$/.test(value)
    || value.split("/").some(p => !p || p === "." || p === ".." || [".git", ".codex", ".ssh", ".aws", ".config", ".copilot", ".opencode", "node_modules"].includes(p.toLowerCase()))
    || /(?:^|\/)(?:auth\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(?:\.(?!example$)[^/]*)?)$|\.(?:pem|key|p12|pfx)$/i.test(value)) {
    throw new Error("Unsupported or protected review path.");
  }
  return value;
}

/** Validate both hunk lengths and GitHub totals; never silently review a truncated patch. */
export function changedLines(change: ReviewChange): Set<number> {
  reviewPath(change.path);
  if (change.previousPath !== undefined) reviewPath(change.previousPath);
  let added = 0, removed = 0, oldRemaining = 0, newRemaining = 0, line = 0;
  const lines = new Set<number>();
  const patch = change.patch.split("\n");
  if (patch.at(-1) === "") patch.pop();
  for (const text of patch) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      if (oldRemaining || newRemaining) throw new Error("Incomplete review patch.");
      oldRemaining = Number(hunk[1] ?? 1); line = Number(hunk[2]); newRemaining = Number(hunk[3] ?? 1);
    } else if (text.startsWith("+")) { added++; newRemaining--; lines.add(line++); }
    else if (text.startsWith("-")) { removed++; oldRemaining--; }
    else if (text.startsWith(" ")) { oldRemaining--; newRemaining--; line++; }
    else if (!text.startsWith("\\ No newline at end of file")) throw new Error("Unsupported review patch.");
    if (oldRemaining < 0 || newRemaining < 0) throw new Error("Invalid review hunk.");
  }
  if (oldRemaining || newRemaining || added !== change.additions || removed !== change.deletions) throw new Error("Incomplete review patch.");
  return lines;
}

export function validateReviewInput(value: unknown): ReviewInput {
  if (!value || typeof value !== "object") throw new Error("Invalid review input.");
  const input = value as ReviewInput;
  reviewId(input.id);
  if (!["Rubiss-Projects/ai-assistant", "Rubiss-Projects/docker"].includes(input.repository)
    || !Number.isSafeInteger(input.pull) || input.pull < 1 || !/^[0-9a-f]{40}$/.test(input.head) || !/^[0-9a-f]{40}$/.test(input.base)
    || !Array.isArray(input.files) || input.files.length > 600 || !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 300
    || !Array.isArray(input.omitted) || input.omitted.some(p => typeof p !== "string")
    || Buffer.byteLength(JSON.stringify(input)) > REVIEW_MAX_BYTES) throw new Error("Review snapshot exceeds supported bounds.");
  const seen = new Set<string>();
  for (const file of input.files) {
    const name = reviewPath(file.path).toLowerCase();
    if ([...seen].some(other => other === name || other.startsWith(`${name}/`) || name.startsWith(`${other}/`))
      || typeof file.content !== "string" || file.content.includes("\0") || Buffer.byteLength(file.content) > 1_000_000) throw new Error("Invalid review source file.");
    seen.add(name);
  }
  const changed = new Set<string>();
  for (const change of input.changes) {
    if (!change || typeof change.patch !== "string" || !["added", "removed", "modified", "renamed", "copied", "changed"].includes(change.status)
      || !Number.isSafeInteger(change.additions) || !Number.isSafeInteger(change.deletions) || change.additions < 0 || change.deletions < 0
      || changed.has(change.path)) throw new Error("Invalid review change.");
    changed.add(change.path);
    changedLines(change);
    if (change.status !== "removed" && !input.files.some(file => file.path === change.path)) throw new Error("Changed source is missing from review snapshot.");
  }
  // Strip all unknown fields. The broker cannot supply commands, runtime options, or instructions.
  return { id: input.id, repository: input.repository, pull: input.pull, head: input.head, base: input.base,
    files: input.files.map(({ path, content }) => ({ path, content })),
    changes: input.changes.map(({ path, previousPath, status, patch, additions, deletions }) => ({ path, ...(previousPath ? { previousPath } : {}), status, patch, additions, deletions })),
    omitted: input.omitted };
}
export const reviewDigest = (input: ReviewInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export const REVIEW_RESULT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "findings"], properties: {
    summary: { type: "string" }, findings: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["priority", "title", "body", "path", "line"], properties: {
        priority: { type: "integer", enum: [0, 1, 2, 3] }, title: { type: "string" }, body: { type: "string" }, path: { type: "string" }, line: { type: "integer" },
      },
    } },
  },
} as const;

export function validateReviewResult(value: unknown, input: Pick<ReviewInput, "changes">): ReviewResult {
  const result = value as ReviewResult;
  const text = (s: unknown, max: number): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= max
    && !/\x00|@codex\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/i.test(s);
  if (!result || !text(result.summary, 4000) || !Array.isArray(result.findings) || result.findings.length > 20) throw new Error("Invalid review result.");
  for (const finding of result.findings) {
    if (!finding || !Number.isInteger(finding.priority) || finding.priority < 0 || finding.priority > 3 || !text(finding.title, 160)
      || !text(finding.body, 2000) || !Number.isSafeInteger(finding.line) || finding.line < 1
      || !input.changes.some(change => change.path === finding.path)) throw new Error("Invalid review finding.");
  }
  return { summary: result.summary, findings: result.findings.map(({ priority, title, body, path, line }) => ({ priority, title, body, path, line })) };
}
