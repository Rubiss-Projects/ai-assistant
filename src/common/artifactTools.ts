import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactCandidate, SendAttachment, SendMessageOptions } from "../providers/types.js";
import { artifactOutputLimits, artifactValidationBudget, normalizePreviewableImage, validateArtifactFile, type ArtifactRun } from "./agentResponse.js";
import { pathIsWithin, workspacePathIsAllowed } from "./providerSecurity.js";
import { artifactFilename, fetchPublicArtifact, inputByteLimit } from "../utils/fetchArtifact.js";
import { discordMessageLocation } from "../utils/artifactMessage.js";
import { transcodeVideo } from "./mediaTranscode.js";

import { ARTIFACT_TOOLS } from "./artifactToolDefinitions.js";
export { ARTIFACT_TOOLS } from "./artifactToolDefinitions.js";

export class ArtifactTools {
  readonly id: string;
  readonly controller = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private calls = 0;
  private downloadedBytes = 0;
  private candidates = new Map<string, ArtifactCandidate>();
  private downloads = new Map<string, unknown>();
  private registered = new Map<string, unknown>();
  private validationBudget = artifactValidationBudget();
  private filenames = new Map<string, string>();
  private retained = 0;
  providerSourceRoot?: () => string | undefined;

  constructor(readonly run: ArtifactRun, readonly options?: SendMessageOptions,
    private readonly download = fetchPublicArtifact) { this.id = path.basename(run.directory); }

  async close(): Promise<void> { this.controller.abort(); await this.queue.catch(() => {}); }

  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const operation = this.queue.catch(() => {}).then(async () => {
      this.controller.signal.throwIfAborted();
      if (args.run_id !== this.id) throw new Error("This artifact run has expired or belongs to another response.");
      if (++this.calls > 40) throw new Error("Artifact tool call limit reached for this response.");
      const schema = ARTIFACT_TOOLS.find((tool) => tool.name === name)?.inputSchema;
      if (!schema || Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))) throw new Error("Invalid artifact tool arguments.");
      for (const key of schema.required) if (typeof args[key] !== "string" || !(args[key] as string).trim()) throw new Error(`Missing ${key}.`);
      for (const value of Object.values(args)) if (typeof value !== "string" || value.length > 8192) throw new Error("Tool arguments must be short strings.");
      if (name === "fetch_artifact") return this.fetch(args);
      if (name === "attach_file") return this.attach(String(args.path), args.filename as string | undefined);
      if ((process.env.DISCORD_ATTACHMENT_MODE ?? "native").trim().toLowerCase() !== "native") throw new Error("Video processing requires DISCORD_ATTACHMENT_MODE=native.");
      if (!["av1", "h264", "hevc"].includes(String(args.codec))) throw new Error("Unsupported target codec.");
      const data = await this.readInput(String(args.path));
      const output = await transcodeVideo(data, args.codec as "av1" | "h264" | "hevc", this.controller.signal);
      return this.save(output, `converted-${args.codec}.mp4`, "video/mp4");
    });
    this.queue = operation;
    return operation;
  }

  /** Give every provider an accessible workspace copy, including binary inputs. */
  async stageInputs(files: SendAttachment[]): Promise<SendAttachment[]> {
    const staged: SendAttachment[] = [];
    for (const file of files) {
      this.controller.signal.throwIfAborted();
      const data = await readRegularFile(file.path, inputByteLimit());
      const saved = await this.save(data, file.displayName ?? path.basename(file.path), "application/octet-stream");
      staged.push({ ...file, path: saved.path });
    }
    return staged;
  }

  private async save(data: Buffer, name: string, contentType: string) {
    this.controller.signal.throwIfAborted();
    if (++this.retained > 20 || this.downloadedBytes + data.length > inputByteLimit() * 2) throw new Error("This response's input storage budget is exhausted.");
    if (!workspacePathIsAllowed(this.run.workingDirectory, this.run.directory)) throw new Error("Artifact directory is no longer valid.");
    const normalized = normalizePreviewableImage(data, artifactFilename(name));
    const filePath = path.join(this.run.directory, `${randomUUID()}-${normalized.displayName}`);
    await fs.writeFile(filePath, normalized.data, { flag: "wx", mode: 0o600 });
    this.filenames.set(filePath, normalized.displayName);
    this.downloadedBytes += normalized.data.length;
    return { artifact_id: path.basename(filePath), path: filePath, filename: normalized.displayName, bytes: normalized.data.length, content_type: contentType };
  }

  private sourceRoot(file: string): { root: string; file: string } {
    const resolved = path.resolve(this.run.workingDirectory, file);
    if (workspacePathIsAllowed(this.run.workingDirectory, resolved)) {
      const relative = path.relative(this.run.workingDirectory, resolved);
      if (relative.split(path.sep).some((part) => part.startsWith(".") && part !== ".env.example")) throw new Error("Hidden workspace files cannot be exported.");
      const artifactRoot = path.join(this.run.workingDirectory, "ai-assistant-artifacts");
      if (pathIsWithin(artifactRoot, resolved) && !pathIsWithin(this.run.directory, resolved)) throw new Error("Files from another artifact run are unavailable.");
      return { root: this.run.workingDirectory, file: resolved };
    }
    const providerRoot = this.providerSourceRoot?.();
    if (providerRoot && workspacePathIsAllowed(providerRoot, resolved)) return { root: providerRoot, file: resolved };
    throw new Error("File must be in this workspace or the current provider thread's generated output directory.");
  }

  private async readInput(file: string): Promise<Buffer> {
    const source = this.sourceRoot(file);
    return readRegularFile(source.file, inputByteLimit());
  }

  private async attach(file: string, filename?: string): Promise<unknown> {
    // Even a failed explicit selection suppresses heuristic delivery of an unrelated file.
    this.run.registeredAttachments ??= [];
    const source = this.sourceRoot(file);
    const attachment = await validateArtifactFile(source.root, source.file, this.validationBudget);
    const identity = createHash("sha256").update(attachment.data).digest("hex");
    if (this.registered.has(identity)) return this.registered.get(identity);
    const limits = artifactOutputLimits();
    if (this.run.registeredAttachments.length >= limits.count) throw new Error(`Only ${limits.count} attachments fit in a response.`);
    if (this.run.registeredAttachments.reduce((total, item) => total + item.data.length, 0) + attachment.data.length > limits.bytes) throw new Error(`Response attachments exceed ${limits.bytes} bytes.`);
    const safeName = artifactFilename(filename ?? this.filenames.get(source.file) ?? attachment.displayName);
    // Preserve an extension changed by normalization (e.g. SVG → PNG), but let
    // callers name extensionless/generic downloads for their intended delivery.
    const extension = path.extname(attachment.displayName);
    attachment.displayName = path.extname(source.file).toLowerCase() === extension.toLowerCase() ? safeName : `${path.parse(safeName).name}${extension}`;
    const saved = await this.save(attachment.data, attachment.displayName, "application/octet-stream");
    this.controller.signal.throwIfAborted();
    this.run.registeredAttachments.push(attachment);
    const result = { artifact_id: saved.artifact_id, filename: attachment.displayName, bytes: attachment.data.length, status: "ready" };
    this.registered.set(identity, result);
    return result;
  }

  private async fetch(args: Record<string, unknown>): Promise<unknown> {
    let candidate: ArtifactCandidate;
    if (args.candidate_id) {
      if (args.url) throw new Error("Provide url or candidate_id, not both.");
      const selected = this.candidates.get(String(args.candidate_id));
      if (!selected) throw new Error("Unknown candidate_id for this response.");
      candidate = selected;
    } else {
      if (typeof args.url !== "string") throw new Error("Provide a URL or a candidate_id.");
      candidate = { url: args.url };
    }
    if (discordMessageLocation(candidate.url)) {
      if (!this.options?.resolveArtifactMessage) throw new Error("Discord message retrieval is unavailable for this run.");
      const seen = new Set<string>();
      const queue = [{ url: candidate.url, depth: 0 }];
      const files = new Map<string, ArtifactCandidate>();
      const warnings: string[] = [];
      while (queue.length && seen.size < 10) {
        this.controller.signal.throwIfAborted();
        const next = queue.shift()!;
        const location = discordMessageLocation(next.url)!;
        const identity = `${location.guild}/${location.channel}/${location.message}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        try {
          const message = await abortable(this.options.resolveArtifactMessage(next.url), this.controller.signal);
          for (const file of message.candidates.slice(0, 20)) {
            if (discordMessageLocation(file.url)) {
              if (next.depth < 3) queue.push({ url: file.url, depth: next.depth + 1 });
              else warnings.push("Discord message link depth limit reached.");
            } else if (files.size < 20) files.set(file.url, file);
          }
        } catch (error) { warnings.push(error instanceof Error ? error.message : "Message lookup failed."); }
      }
      if (queue.length) warnings.push("Discord message lookup limit reached.");
      const candidates = [...files.values()];
      if (!candidates.length) throw new Error(warnings.join(" ") || "No files or media links found in this Discord message.");
      if (candidates.length > 1) {
        return { candidates: candidates.map((file) => {
          const id = randomUUID(); this.candidates.set(id, file);
          return { candidate_id: id, ...file };
        }), warnings };
      }
      candidate = candidates[0];
    }
    if (this.downloads.has(candidate.url)) return this.downloads.get(candidate.url);
    if (candidate.size && candidate.size > inputByteLimit()) throw new Error(`Input exceeds the ${inputByteLimit()}-byte limit.`);
    const fetched = await this.download(candidate.url, this.controller.signal);
    if ((process.env.DISCORD_ATTACHMENT_MODE ?? "native").trim().toLowerCase() !== "native") {
      const head = fetched.data.subarray(0, 12);
      if (!head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        && !(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
        && !/^GIF8[79]a/.test(head.toString("ascii"))
        && !(head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP")) {
        throw new Error("Text mode permits downloads of raster images only.");
      }
    }
    const result = await this.save(fetched.data, candidate.name ?? fetched.filename, fetched.contentType);
    const sourced = { ...result, source_url: candidate.url, source_message: candidate.sourceMessage };
    this.downloads.set(candidate.url, sourced);
    return sourced;
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Artifact operation cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function readRegularFile(file: string, limit: number): Promise<Buffer> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error(`Input must be a regular file no larger than ${limit} bytes.`);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1) throw new Error("Input changed while opening.");
    const data = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("Input changed while reading.");
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}
