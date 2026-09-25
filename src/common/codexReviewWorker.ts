import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { REVIEW_LIMIT, REVIEW_MAX_BYTES, REVIEW_SOCKET, reviewDigest, reviewId, validateReviewInput, validateReviewResult, type ReviewInput, type ReviewJob, type ReviewResult } from "./codexReviewProtocol.js";

export function writeReviewState(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** Durable receipts prevent duplicate inference after lost replies or service restarts. */
export class CodexReviewWorker {
  private readonly jobs = new Map<string, ReviewJob>();
  private active?: Promise<void>;
  private readonly abort = new AbortController();
  constructor(private readonly directory: string, private readonly run: (input: ReviewInput, signal: AbortSignal) => Promise<ReviewResult>) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
      const job = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as ReviewJob;
      if (`${reviewId(job.id)}.json` !== file || !["queued", "running", "completed", "failed"].includes(job.state)) throw new Error("Invalid worker state.");
      // Never silently spend a second review after an interrupted invocation.
      if (["queued", "running"].includes(job.state)) { job.state = "failed"; job.error = "Review interrupted by worker restart; retry explicitly if budget remains."; this.save(job); }
      this.jobs.set(job.id, job);
    }
  }
  private save(job: ReviewJob) { writeReviewState(path.join(this.directory, `${job.id}.json`), job); }
  get(id: string) { return this.jobs.get(reviewId(id)); }
  submit(raw: unknown): ReviewJob {
    const input = validateReviewInput(raw);
    const digest = reviewDigest(input);
    const previous = this.jobs.get(input.id);
    if (previous) {
      if (previous.digest !== digest) throw new Error("Review ID was already used for a different snapshot.");
      return previous;
    }
    if (this.active || this.abort.signal.aborted) throw new Error("Review worker is busy or stopping.");
    if (this.jobs.size >= 5000) throw new Error("Review history capacity reached; operator maintenance required.");
    if ([...this.jobs.values()].filter(job => job.repository === input.repository && job.pull === input.pull).length >= REVIEW_LIMIT) throw new Error("Five-review limit reached for this PR.");
    const job: ReviewJob = { id: input.id, digest, repository: input.repository, pull: input.pull, head: input.head, base: input.base, state: "queued" };
    this.save(job); this.jobs.set(job.id, job);
    this.active = Promise.resolve().then(async () => {
      job.state = "running"; this.save(job);
      try { job.result = validateReviewResult(await this.run(input, this.abort.signal), input); job.state = "completed"; }
      catch { job.state = "failed"; job.error = "Codex review failed or was interrupted. Check the worker login, subscription limits, and operator logs before retrying."; }
      this.save(job);
    }).finally(() => { this.active = undefined; });
    void this.active.catch(() => { console.error("[codex-review] Could not persist job result; stopping worker."); this.abort.abort(); });
    return job;
  }
  async close() { this.abort.abort(); await this.active; }
}

export async function serveReviews(worker: CodexReviewWorker, socket = REVIEW_SOCKET): Promise<Server> {
  if (fs.existsSync(socket)) {
    if (!fs.lstatSync(socket).isSocket()) throw new Error("Review socket path is not a socket.");
    fs.unlinkSync(socket);
  }
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      if (req.method === "GET" && req.url === "/health") { res.end('{"ok":true}'); return; }
      if (req.method === "GET" && req.url?.startsWith("/jobs/")) {
        const job = worker.get(req.url.slice(6));
        res.writeHead(job ? 200 : 404).end(JSON.stringify(job ?? { error: "Unknown review." })); return;
      }
      if (req.method !== "POST" || req.url !== "/jobs") { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > REVIEW_MAX_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      res.end(JSON.stringify(worker.submit(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
    } catch { res.writeHead(409).end('{"error":"Review request rejected; check job status and budget before retrying."}'); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { fs.chmodSync(socket, 0o600); resolve(); }); });
  return server;
}

export interface ReviewTransport { get(id: string, signal: AbortSignal): Promise<ReviewJob | undefined>; submit(input: ReviewInput, signal: AbortSignal): Promise<ReviewJob> }
export class ReviewSocketClient implements ReviewTransport {
  constructor(private readonly socket = REVIEW_SOCKET) {}
  private call(method: string, endpoint: string, signal: AbortSignal, body?: ReviewInput): Promise<ReviewJob | undefined> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socket, path: endpoint, method, signal, timeout: 15_000, headers: { "content-type": "application/json" } }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 150_000) req.destroy(new Error("Excessive review response.")); else chunks.push(chunk); });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode === 404) { resolve(undefined); return; }
          if (res.statusCode !== 200) { reject(new Error("Review worker unavailable or busy.")); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReviewJob); } catch { reject(new Error("Invalid review worker response.")); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("Review worker timed out.")));
      req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  get(id: string, signal: AbortSignal) { return this.call("GET", `/jobs/${reviewId(id)}`, signal); }
  async submit(input: ReviewInput, signal: AbortSignal) {
    const job = await this.call("POST", "/jobs", signal, input);
    if (!job) throw new Error("Review worker did not acknowledge the job.");
    return job;
  }
}
