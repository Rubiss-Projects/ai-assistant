import { createHash, randomUUID } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs";
import path from "node:path";
import { decompressFrames, parseGIF, type ParsedFrame, type ParsedGif } from "gifuct-js";
import gifenc from "gifenc";
import { configuredMilliseconds } from "./runLifecycle.js";
import { workspacePathIsAllowed } from "./providerSecurity.js";
import type { AgentResponse, ResponseAttachment } from "../providers/types.js";

const ARTIFACT_ROOT = "ai-assistant-artifacts";
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 10;
const ABSOLUTE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DISCORD_MAX_ATTACHMENTS = 10;
const MAX_GIF_FRAMES = 200;
const MAX_GIF_TOTAL_PIXELS = 20_000_000;
const MAX_GIF_RESPONSE_WORK_PIXELS = MAX_GIF_TOTAL_PIXELS * 2;
const ARTIFACT_MARKER = /^\s*\[\[artifact:(.+?)\]\]\s*$/gim;

export const ARTIFACT_INSTRUCTIONS = [
  "When a turn includes an artifact-output directory and you create a file that the user explicitly asked to download or view, save the file in that directory.",
  "Save images intended for inline viewing as PNG, JPEG, GIF, or WebP rather than SVG, because Discord does not preview SVG attachments.",
  "Animated GIFs must use a standards-compliant encoder and every frame must decode successfully before delivery.",
  "This Discord client cannot see images displayed only inside a provider interface: even if an image-generation tool says its output is already displayed, copy the raster image into the artifact-output directory and emit its artifact marker.",
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

export interface GifWorkBudget {
  remainingPixels: number;
}

function gifRepeatCount(parsed: ParsedGif): number {
  const loopExtensions = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);
  const application = parsed.frames.find(
    (frame) => "application" in frame && loopExtensions.has(frame.application.id),
  );
  if (!application || !("application" in application) || application.application.blocks.length < 3) return -1;
  return application.application.blocks[1] | (application.application.blocks[2] << 8);
}

function gifLzwDecodesExactly(minCodeSize: number, data: number[], pixelCount: number): boolean {
  if (minCodeSize < 2 || minCodeSize > 8 || pixelCount < 1) return false;
  const dictionarySize = 4_096;
  const prefix = new Int32Array(dictionarySize);
  const suffix = new Int32Array(dictionarySize);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  for (let code = 0; code < clearCode; code++) suffix[code] = code;

  let available = clearCode + 2;
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let oldCode = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let byteIndex = 0;
  let produced = 0;
  let codesRead = 0;
  const maxCodes = pixelCount * 2 + 1_024;

  const readCode = (): number | undefined => {
    while (bits < codeSize) {
      if (byteIndex >= data.length) return undefined;
      datum |= data[byteIndex++] << bits;
      bits += 8;
    }
    const code = datum & codeMask;
    datum >>>= codeSize;
    bits -= codeSize;
    return code;
  };

  while (true) {
    let code = readCode();
    if (code === undefined) return false;
    codesRead += 1;
    if (codesRead > maxCodes) return false;
    if (code === clearCode) {
      available = clearCode + 2;
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      oldCode = -1;
      continue;
    }
    if (code === endCode) return produced === pixelCount;
    if (code > available) return false;

    if (oldCode === -1) {
      if (code >= clearCode) return false;
      produced += 1;
      first = code;
      oldCode = code;
      continue;
    }

    const inputCode = code;
    let emitted = 0;
    if (code === available) {
      emitted += 1;
      code = oldCode;
    }
    let depth = 0;
    while (code > clearCode) {
      if (code >= available || depth++ >= dictionarySize) return false;
      emitted += 1;
      code = prefix[code];
    }
    if (code >= clearCode) return false;
    first = suffix[code] & 0xff;
    emitted += 1;
    produced += emitted;
    if (produced > pixelCount) return false;

    if (available < dictionarySize) {
      prefix[available] = oldCode;
      suffix[available] = first;
      available += 1;
      if ((available & codeMask) === 0 && available < dictionarySize) {
        codeSize += 1;
        codeMask = (1 << codeSize) - 1;
      }
    }
    oldCode = inputCode;
  }
}

function composeGifFrame(canvas: Uint8ClampedArray, frame: ParsedFrame, width: number, height: number): void {
  const { left, top, width: frameWidth, height: frameHeight } = frame.dims;
  if (left < 0 || top < 0 || frameWidth < 1 || frameHeight < 1
    || left + frameWidth > width || top + frameHeight > height
    || frame.patch.length !== frameWidth * frameHeight * 4) {
    throw new Error("GIF frame dimensions are invalid.");
  }
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      const source = (y * frameWidth + x) * 4;
      if (frame.patch[source + 3] === 0) continue;
      const destination = ((top + y) * width + left + x) * 4;
      canvas.set(frame.patch.subarray(source, source + 4), destination);
    }
  }
}

function gifBackground(
  parsed: ParsedGif,
  firstFrame: ParsedFrame,
  firstFrameUsesLocalColorTable: boolean,
): [number, number, number, number] {
  if (!parsed.lsd.gct.exists || !parsed.gct) return [0, 0, 0, 0];
  const index = parsed.lsd.backgroundColorIndex;
  const [red, green, blue] = parsed.gct[index] ?? [0, 0, 0];
  const transparent = !firstFrameUsesLocalColorTable && firstFrame.transparentIndex === index;
  return [red, green, blue, transparent ? 0 : 255];
}

function fillGifCanvas(canvas: Uint8ClampedArray, color: [number, number, number, number]): void {
  for (let offset = 0; offset < canvas.length; offset += 4) canvas.set(color, offset);
}

function clearGifFrame(
  canvas: Uint8ClampedArray,
  frame: ParsedFrame,
  width: number,
  background: [number, number, number, number],
): void {
  const { left, top, width: frameWidth, height: frameHeight } = frame.dims;
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      canvas.set(background, ((top + y) * width + left + x) * 4);
    }
  }
}

/** Fully decode and re-encode GIFs so Discord never receives header-only or browser-incompatible output. */
export function normalizeGifForDiscord(
  data: Buffer,
  displayName: string,
  maxBytes: number,
  workBudget: GifWorkBudget = { remainingPixels: MAX_GIF_RESPONSE_WORK_PIXELS },
): ResponseAttachment {
  const parsed = parseGIF(new Uint8Array(data).buffer);
  const { width, height } = parsed.lsd;
  if (parsed.header.signature !== "GIF" || !["87a", "89a"].includes(parsed.header.version)
    || width < 1 || height < 1 || width > 8_192 || height > 8_192) {
    throw new Error("GIF header or dimensions are invalid.");
  }

  let frameCount = 0;
  let decodedPixels = 0;
  let firstFrameUsesLocalColorTable = false;
  for (const frame of parsed.frames) {
    if (!("image" in frame)) continue;
    const descriptor = frame.image.descriptor;
    if (descriptor.left < 0 || descriptor.top < 0 || descriptor.width < 1 || descriptor.height < 1
      || descriptor.left + descriptor.width > width || descriptor.top + descriptor.height > height) {
      throw new Error("GIF frame dimensions are invalid.");
    }
    frameCount += 1;
    decodedPixels += descriptor.width * descriptor.height;
    if (frameCount === 1) firstFrameUsesLocalColorTable = descriptor.lct.exists;
    if (frameCount > MAX_GIF_FRAMES || decodedPixels > MAX_GIF_TOTAL_PIXELS
      || width * height * frameCount > MAX_GIF_TOTAL_PIXELS) {
      throw new Error("GIF exceeds the safe animation complexity limit.");
    }
  }
  if (frameCount < 1) throw new Error("GIF does not contain an image frame.");

  // Reserve the maximum decode/composition work before traversing LZW streams.
  // A single response shares this budget across all distinct artifact markers.
  const workPixels = decodedPixels + width * height * frameCount;
  if (workPixels > workBudget.remainingPixels) {
    throw new Error("GIF exceeds the safe response-wide animation work limit.");
  }
  workBudget.remainingPixels -= workPixels;

  for (const frame of parsed.frames) {
    if (!("image" in frame)) continue;
    const descriptor = frame.image.descriptor;
    if (!gifLzwDecodesExactly(
      frame.image.data.minCodeSize,
      frame.image.data.blocks,
      descriptor.width * descriptor.height,
    )) {
      throw new Error("GIF frame has an invalid LZW stream.");
    }
  }

  const frames = decompressFrames(parsed, true);
  if (frames.length !== frameCount) throw new Error("GIF frame decoding was incomplete.");

  const { GIFEncoder, quantize, applyPalette } = gifenc;
  const encoder = GIFEncoder();
  const canvas = new Uint8ClampedArray(width * height * 4);
  const background = gifBackground(parsed, frames[0], firstFrameUsesLocalColorTable);
  fillGifCanvas(canvas, background);
  const repeat = gifRepeatCount(parsed);
  for (const frame of frames) {
    const restore = frame.disposalType === 3 ? canvas.slice() : undefined;
    composeGifFrame(canvas, frame, width, height);
    const rendered = canvas.slice();
    const hasTransparency = rendered.some((_value, index) => index % 4 === 3 && rendered[index] < 128);
    const format = hasTransparency ? "rgba4444" : "rgb565";
    const palette = quantize(rendered, 256, { format, oneBitAlpha: hasTransparency });
    const indexed = applyPalette(rendered, palette, format);
    const transparentIndex = hasTransparency ? palette.findIndex((color: number[]) => color[3] === 0) : -1;
    encoder.writeFrame(indexed, width, height, {
      palette,
      delay: frame.delay,
      repeat,
      dispose: 1,
      transparent: transparentIndex >= 0,
      transparentIndex,
    });
    if (frame.disposalType === 2) clearGifFrame(canvas, frame, width, background);
    else if (restore) canvas.set(restore);
  }
  encoder.finish();
  const normalized = Buffer.from(encoder.bytes());
  if (normalized.byteLength > maxBytes) {
    throw new Error(`normalized GIF exceeds the configured ${maxBytes}-byte limit.`);
  }
  return { data: normalized, displayName };
}

function normalizeOutputAttachment(
  data: Buffer,
  displayName: string,
  maxBytes: number,
  gifWorkBudget: GifWorkBudget,
): ResponseAttachment {
  const normalized = normalizePreviewableImage(data, displayName);
  return path.extname(normalized.displayName).toLowerCase() === ".gif"
    ? normalizeGifForDiscord(normalized.data, normalized.displayName, maxBytes, gifWorkBudget)
    : normalized;
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
  gifWorkBudget: GifWorkBudget,
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
    return { attachment: normalizeOutputAttachment(data, displayName, maxBytes, gifWorkBudget) };
  } catch (error) {
    if (path.extname(displayName).toLowerCase() === ".gif") {
      return { warning: attachmentWarning(displayName, `the GIF could not be decoded safely (${String(error)}).`) };
    }
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
    // The imported marker is loaded through normalizeOutputAttachment below;
    // only unwrap SVG shells here so GIFs are decoded and re-encoded exactly once.
    const normalized = normalizePreviewableImage(data, safeDisplayName(requestedName));
    const baseName = safeDisplayName(normalized.displayName);
    const destinationName = fs.existsSync(path.join(run.directory, baseName)) ? `${index + 1}-${baseName}` : baseName;
    const destination = path.join(run.directory, destinationName);
    await fs.promises.writeFile(destination, normalized.data, { flag: "wx", mode: 0o600 });
    return { marker: path.relative(run.workingDirectory, destination) };
  } catch (error) {
    if (path.extname(requestedName).toLowerCase() === ".gif") {
      return { warning: attachmentWarning(requestedName, `the provider GIF could not be decoded safely (${String(error)}).`) };
    }
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
  const seenContent = new Set<string>();
  let totalBytes = 0;
  let processedCandidates = 0;
  const gifWorkBudget: GifWorkBudget = { remainingPixels: MAX_GIF_RESPONSE_WORK_PIXELS };

  for (const requestedPath of requestedPaths) {
    const resolvedIdentity = path.resolve(run.workingDirectory, requestedPath.trim());
    const identity = process.platform === "win32" ? resolvedIdentity.toLowerCase() : resolvedIdentity;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (processedCandidates >= maxAttachments) {
      warnings.push(attachmentWarning(requestedPath, `only ${maxAttachments} attachments are allowed per response.`));
      continue;
    }
    processedCandidates += 1;

    const result = await loadAttachment(run, requestedPath, maxBytes, gifWorkBudget);
    if (result.attachment) {
      const contentIdentity = createHash("sha256").update(result.attachment.data).digest("hex");
      if (seenContent.has(contentIdentity)) continue;
      seenContent.add(contentIdentity);
      const remainingBytes = maxTotalBytes - totalBytes;
      if (result.attachment.data.byteLength > remainingBytes) {
        warnings.push(attachmentWarning(requestedPath, `it exceeds the remaining ${remainingBytes}-byte limit.`));
        continue;
      }
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
