import { randomUUID } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs";
import path from "node:path";
import { configuredMilliseconds } from "./runLifecycle.js";
import { workspacePathIsAllowed } from "./providerSecurity.js";
import type { AgentResponse, ResponseAttachment } from "../providers/types.js";

const ARTIFACT_ROOT = "ai-assistant-artifacts";
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 10;
const ABSOLUTE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DISCORD_MAX_ATTACHMENTS = 10;
const ARTIFACT_MARKER = /^\s*\[\[artifact:(.+?)\]\]\s*$/gim;

export const ARTIFACT_INSTRUCTIONS = [
  "When a turn includes an artifact-output directory and you create a file that the user explicitly asked to download or view, save the file in that directory.",
  "Save images intended for inline viewing as PNG, JPEG, GIF, or WebP rather than SVG, because Discord does not preview SVG attachments.",
  "Include one marker on its own line at the end of your final response using the workspace-relative path: [[artifact:artifact-output/path/to/file]].",
  "Include only completed output artifacts, not every file edited during ordinary coding work.",
].join(" ");

export interface ArtifactRun {
  workingDirectory: string;
  directory: string;
  relativeDirectory: string;
}

export interface ProviderArtifact {
  path: string;
  trustedRoot: string;
  displayName?: string;
}

export interface AgentOperationResult {
  content: string;
  artifacts?: ProviderArtifact[];
}

function boundedConfiguration(key: string, fallback: number, maximum: number): number {
  return Math.min(configuredMilliseconds(key, fallback, 1), maximum);
}

function safeDisplayName(candidate: string): string {
  return path.basename(candidate).replace(/[\r\n\0]/g, "_") || "attachment";
}

function attachmentWarning(name: string, reason: string): string {
  return `⚠️ Could not attach \`${safeDisplayName(name)}\`: ${reason}`;
}

const RASTER_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export function rasterSignatureMatches(data: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png":
      return data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "image/jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/gif":
      return data.subarray(0, 6).toString("ascii") === "GIF87a"
        || data.subarray(0, 6).toString("ascii") === "GIF89a";
    case "image/webp":
      return data.subarray(0, 4).toString("ascii") === "RIFF"
        && data.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

/** Unwrap the single embedded raster emitted by some image tools as an SVG shell. */
export function normalizePreviewableImage(data: Buffer, displayName: string): ResponseAttachment {
  if (path.extname(displayName).toLowerCase() !== ".svg") return { data, displayName };

  const svg = data.toString("utf8");
  const imageTag = svg.match(/<image\b[\s\S]*?(?:\/\s*>|>\s*<\/image\s*>)/i)?.[0];
  if (!imageTag) return { data, displayName };

  const shell = svg.replace(imageTag, "");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b[^>]*>\s*<\/svg\s*>\s*$/is.test(shell)) {
    return { data, displayName };
  }

  const embedded = imageTag.match(
    /\b(?:href|xlink:href)\s*=\s*(["'])data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)\1/i,
  );
  if (!embedded) return { data, displayName };
  const mimeType = embedded[2].toLowerCase();
  const base64 = embedded[3].replace(/\s/g, "");
  if (base64.length === 0 || base64.length % 4 !== 0) return { data, displayName };

  const raster = Buffer.from(base64, "base64");
  if (raster.toString("base64") !== base64) return { data, displayName };
  if (!rasterSignatureMatches(raster, mimeType)) return { data, displayName };
  const extension = RASTER_EXTENSIONS[mimeType];
  return { data: raster, displayName: `${path.basename(displayName, path.extname(displayName))}${extension}` };
}

function createArtifactRun(workingDirectory: string): ArtifactRun {
  const root = path.join(workingDirectory, ARTIFACT_ROOT);
  if (!workspacePathIsAllowed(workingDirectory, ARTIFACT_ROOT)) {
    throw new Error("The artifact output directory is not allowed in this workspace.");
  }
  if (fs.existsSync(root)) {
    const rootStats = fs.lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error(`Artifact output path must be a regular directory: ${root}`);
    }
  } else {
    fs.mkdirSync(root, { mode: 0o700 });
  }

  const runId = randomUUID();
  const relativeDirectory = path.join(ARTIFACT_ROOT, runId);
  const directory = path.join(workingDirectory, relativeDirectory);
  fs.mkdirSync(directory, { mode: 0o700 });
  return { workingDirectory, directory, relativeDirectory };
}

function removeEmptyArtifactRun(run: ArtifactRun): void {
  if (!workspacePathIsAllowed(run.workingDirectory, run.relativeDirectory)) return;
  try {
    // Never recursively delete an agent-writable path: a raced junction could
    // redirect recursive deletion outside the workspace. Empty-only removal is
    // safe; completed artifacts intentionally remain in the ignored run folder.
    fs.rmdirSync(run.directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      console.warn("[artifacts] Could not remove an empty per-turn artifact directory:", error);
    }
  }
}

export function withArtifactOutputPrompt(prompt: string, run: ArtifactRun): string {
  const portablePath = run.relativeDirectory.split(path.sep).join("/");
  return `${prompt}\n\n<artifact-output>For this turn, save downloadable outputs only under ${portablePath}/ and mark them with their workspace-relative path.</artifact-output>`;
}

async function loadAttachment(
  run: ArtifactRun,
  requestedPath: string,
  maxBytes: number,
): Promise<{ attachment?: ResponseAttachment; warning?: string }> {
  const trimmed = requestedPath.trim();
  const displayName = safeDisplayName(trimmed);
  const absolutePath = path.resolve(run.workingDirectory, trimmed);
  const relativeToRun = path.relative(run.directory, absolutePath);
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    relativeToRun === "" ||
    relativeToRun === ".." ||
    relativeToRun.startsWith(".." + path.sep) ||
    path.isAbsolute(relativeToRun)
  ) {
    return { warning: attachmentWarning(displayName, "the path is outside this turn's artifact directory.") };
  }
  if (!workspacePathIsAllowed(run.workingDirectory, trimmed)) {
    return { warning: attachmentWarning(displayName, "the path is outside the allowed workspace.") };
  }

  let beforeOpen: fs.Stats;
  try {
    beforeOpen = fs.lstatSync(absolutePath);
  } catch {
    return { warning: attachmentWarning(displayName, "the file does not exist.") };
  }
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1) {
    return { warning: attachmentWarning(displayName, "only regular files can be attached.") };
  }
  if (beforeOpen.size > maxBytes) {
    return { warning: attachmentWarning(displayName, `it exceeds the configured ${maxBytes}-byte limit.`) };
  }

  let handle: fs.promises.FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await fs.promises.open(absolutePath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== beforeOpen.dev ||
      opened.ino !== beforeOpen.ino ||
      opened.size !== beforeOpen.size ||
      opened.nlink !== 1 ||
      opened.nlink !== beforeOpen.nlink
    ) {
      return { warning: attachmentWarning(displayName, "the file changed while it was being opened.") };
    }
    const data = await handle.readFile();
    if (data.byteLength !== opened.size) {
      return { warning: attachmentWarning(displayName, "the file changed while it was being read.") };
    }
    return { attachment: normalizePreviewableImage(data, displayName) };
  } catch {
    return { warning: attachmentWarning(displayName, "the file could not be read safely.") };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function importProviderArtifact(
  run: ArtifactRun,
  artifact: ProviderArtifact,
  index: number,
): Promise<{ marker?: string; warning?: string }> {
  const requestedName = artifact.displayName ?? (path.basename(artifact.path) || `provider-artifact-${index + 1}`);
  let canonicalRoot: string;
  let canonicalSource: string;
  try {
    canonicalRoot = fs.realpathSync.native(artifact.trustedRoot);
    canonicalSource = fs.realpathSync.native(artifact.path);
  } catch {
    return { warning: attachmentWarning(requestedName, "the provider output does not exist.") };
  }
  const relativeSource = path.relative(canonicalRoot, canonicalSource);
  if (relativeSource === "" || relativeSource === ".." || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
    return { warning: attachmentWarning(requestedName, "the provider output is outside its trusted directory.") };
  }

  let beforeOpen: fs.Stats;
  try {
    beforeOpen = fs.lstatSync(canonicalSource);
  } catch {
    return { warning: attachmentWarning(requestedName, "the provider output does not exist.") };
  }
  const maxBytes = boundedConfiguration(
    "AI_OUTPUT_ATTACHMENT_MAX_BYTES",
    DEFAULT_MAX_ATTACHMENT_BYTES,
    ABSOLUTE_MAX_TOTAL_BYTES,
  );
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1) {
    return { warning: attachmentWarning(requestedName, "the provider output is not a regular file.") };
  }
  if (beforeOpen.size > maxBytes) {
    return { warning: attachmentWarning(requestedName, `it exceeds the configured ${maxBytes}-byte limit.`) };
  }

  let handle: fs.promises.FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await fs.promises.open(canonicalSource, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino
      || opened.size !== beforeOpen.size || opened.nlink !== 1) {
      return { warning: attachmentWarning(requestedName, "the provider output changed while it was being opened.") };
    }
    const data = await handle.readFile();
    if (data.byteLength !== opened.size) {
      return { warning: attachmentWarning(requestedName, "the provider output changed while it was being read.") };
    }
    const normalized = normalizePreviewableImage(data, safeDisplayName(requestedName));
    const baseName = safeDisplayName(normalized.displayName);
    const destinationName = fs.existsSync(path.join(run.directory, baseName)) ? `${index + 1}-${baseName}` : baseName;
    const destination = path.join(run.directory, destinationName);
    await fs.promises.writeFile(destination, normalized.data, { flag: "wx", mode: 0o600 });
    return { marker: path.relative(run.workingDirectory, destination) };
  } catch {
    return { warning: attachmentWarning(requestedName, "the provider output could not be imported safely.") };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function prepareAgentResponse(content: string, run: ArtifactRun): Promise<AgentResponse> {
  const requestedPaths: string[] = [];
  const text = content.replace(ARTIFACT_MARKER, (_marker, requestedPath: string) => {
    requestedPaths.push(requestedPath);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();

  const maxTotalBytes = boundedConfiguration(
    "AI_OUTPUT_ATTACHMENT_MAX_TOTAL_BYTES",
    DEFAULT_MAX_TOTAL_BYTES,
    ABSOLUTE_MAX_TOTAL_BYTES,
  );
  const maxBytes = boundedConfiguration(
    "AI_OUTPUT_ATTACHMENT_MAX_BYTES",
    DEFAULT_MAX_ATTACHMENT_BYTES,
    maxTotalBytes,
  );
  const maxAttachments = boundedConfiguration(
    "AI_OUTPUT_ATTACHMENT_MAX_COUNT",
    DEFAULT_MAX_ATTACHMENTS,
    DISCORD_MAX_ATTACHMENTS,
  );
  const attachments: ResponseAttachment[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const requestedPath of requestedPaths) {
    const resolvedIdentity = path.resolve(run.workingDirectory, requestedPath.trim());
    const identity = process.platform === "win32" ? resolvedIdentity.toLowerCase() : resolvedIdentity;
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (attachments.length >= maxAttachments) {
      warnings.push(attachmentWarning(requestedPath, `only ${maxAttachments} attachments are allowed per response.`));
      continue;
    }
    const remainingBytes = maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      warnings.push(attachmentWarning(requestedPath, `the ${maxTotalBytes}-byte response limit has been reached.`));
      continue;
    }
    const result = await loadAttachment(run, requestedPath, Math.min(maxBytes, remainingBytes));
    if (result.attachment) {
      totalBytes += result.attachment.data.byteLength;
      attachments.push(result.attachment);
    }
    if (result.warning) warnings.push(result.warning);
  }

  const visibleContent = [text || (attachments.length ? "📎 Attached file(s)." : "(no response)"), ...warnings]
    .filter(Boolean)
    .join("\n\n");
  const claimsDelivery = /\b(?:attached|uploaded)\b/i.test(text)
    && !/\b(?:not|never|wasn't|isn't|couldn't|failed to)\s+(?:attached|uploaded)\b/i.test(text);
  const deliveryWarning = attachments.length === 0 && claimsDelivery
    ? "⚠️ No attachment was produced for this response."
    : "";
  return { content: [visibleContent, deliveryWarning].filter(Boolean).join("\n\n"), attachments };
}

export async function captureAgentArtifacts(
  workingDirectory: string,
  operation: (run: ArtifactRun) => Promise<string | AgentOperationResult>,
): Promise<AgentResponse> {
  const run = createArtifactRun(workingDirectory);
  try {
    const output = await operation(run);
    if (typeof output === "string") return await prepareAgentResponse(output, run);

    const markers: string[] = [];
    const warnings: string[] = [];
    for (let index = 0; index < (output.artifacts?.length ?? 0); index++) {
      const imported = await importProviderArtifact(run, output.artifacts![index], index);
      if (imported.marker) markers.push(`[[artifact:${imported.marker}]]`);
      if (imported.warning) warnings.push(imported.warning);
    }
    return await prepareAgentResponse([output.content, ...markers, ...warnings].filter(Boolean).join("\n\n"), run);
  } finally {
    removeEmptyArtifactRun(run);
  }
}
