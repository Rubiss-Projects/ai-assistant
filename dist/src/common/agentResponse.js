import { randomUUID } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs";
import path from "node:path";
import { configuredMilliseconds } from "./runLifecycle.js";
import { workspacePathIsAllowed } from "./providerSecurity.js";
const ARTIFACT_ROOT = "ai-assistant-artifacts";
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 10;
const ABSOLUTE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DISCORD_MAX_ATTACHMENTS = 10;
const ARTIFACT_MARKER = /^\s*\[\[artifact:(.+?)\]\]\s*$/gim;
export const ARTIFACT_INSTRUCTIONS = [
    "When a turn includes an artifact-output directory and you create a file that the user explicitly asked to download or view, save the file in that directory.",
    "Include one marker on its own line at the end of your final response using the workspace-relative path: [[artifact:artifact-output/path/to/file]].",
    "Include only completed output artifacts, not every file edited during ordinary coding work.",
].join(" ");
function boundedConfiguration(key, fallback, maximum) {
    return Math.min(configuredMilliseconds(key, fallback, 1), maximum);
}
function safeDisplayName(candidate) {
    return path.basename(candidate).replace(/[\r\n\0]/g, "_") || "attachment";
}
function attachmentWarning(name, reason) {
    return `⚠️ Could not attach \`${safeDisplayName(name)}\`: ${reason}`;
}
function createArtifactRun(workingDirectory) {
    const root = path.join(workingDirectory, ARTIFACT_ROOT);
    if (!workspacePathIsAllowed(workingDirectory, ARTIFACT_ROOT)) {
        throw new Error("The artifact output directory is not allowed in this workspace.");
    }
    if (fs.existsSync(root)) {
        const rootStats = fs.lstatSync(root);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
            throw new Error(`Artifact output path must be a regular directory: ${root}`);
        }
    }
    else {
        fs.mkdirSync(root, { mode: 0o700 });
    }
    const runId = randomUUID();
    const relativeDirectory = path.join(ARTIFACT_ROOT, runId);
    const directory = path.join(workingDirectory, relativeDirectory);
    fs.mkdirSync(directory, { mode: 0o700 });
    return { workingDirectory, directory, relativeDirectory };
}
function removeEmptyArtifactRun(run) {
    if (!workspacePathIsAllowed(run.workingDirectory, run.relativeDirectory))
        return;
    try {
        // Never recursively delete an agent-writable path: a raced junction could
        // redirect recursive deletion outside the workspace. Empty-only removal is
        // safe; completed artifacts intentionally remain in the ignored run folder.
        fs.rmdirSync(run.directory);
    }
    catch (error) {
        const code = error.code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
            console.warn("[artifacts] Could not remove an empty per-turn artifact directory:", error);
        }
    }
}
export function withArtifactOutputPrompt(prompt, run) {
    const portablePath = run.relativeDirectory.split(path.sep).join("/");
    return `${prompt}\n\n<artifact-output>For this turn, save downloadable outputs only under ${portablePath}/ and mark them with their workspace-relative path.</artifact-output>`;
}
async function loadAttachment(run, requestedPath, maxBytes) {
    const trimmed = requestedPath.trim();
    const displayName = safeDisplayName(trimmed);
    const absolutePath = path.resolve(run.workingDirectory, trimmed);
    const relativeToRun = path.relative(run.directory, absolutePath);
    if (!trimmed ||
        trimmed.includes("\0") ||
        relativeToRun === "" ||
        relativeToRun === ".." ||
        relativeToRun.startsWith(".." + path.sep) ||
        path.isAbsolute(relativeToRun)) {
        return { warning: attachmentWarning(displayName, "the path is outside this turn's artifact directory.") };
    }
    if (!workspacePathIsAllowed(run.workingDirectory, trimmed)) {
        return { warning: attachmentWarning(displayName, "the path is outside the allowed workspace.") };
    }
    let beforeOpen;
    try {
        beforeOpen = fs.lstatSync(absolutePath);
    }
    catch {
        return { warning: attachmentWarning(displayName, "the file does not exist.") };
    }
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1) {
        return { warning: attachmentWarning(displayName, "only regular files can be attached.") };
    }
    if (beforeOpen.size > maxBytes) {
        return { warning: attachmentWarning(displayName, `it exceeds the configured ${maxBytes}-byte limit.`) };
    }
    let handle;
    try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        handle = await fs.promises.open(absolutePath, fsConstants.O_RDONLY | noFollow);
        const opened = await handle.stat();
        if (!opened.isFile() ||
            opened.dev !== beforeOpen.dev ||
            opened.ino !== beforeOpen.ino ||
            opened.size !== beforeOpen.size ||
            opened.nlink !== 1 ||
            opened.nlink !== beforeOpen.nlink) {
            return { warning: attachmentWarning(displayName, "the file changed while it was being opened.") };
        }
        const data = await handle.readFile();
        if (data.byteLength !== opened.size) {
            return { warning: attachmentWarning(displayName, "the file changed while it was being read.") };
        }
        return { attachment: { data, displayName } };
    }
    catch {
        return { warning: attachmentWarning(displayName, "the file could not be read safely.") };
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function prepareAgentResponse(content, run) {
    const requestedPaths = [];
    const text = content.replace(ARTIFACT_MARKER, (_marker, requestedPath) => {
        requestedPaths.push(requestedPath);
        return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    const maxTotalBytes = boundedConfiguration("AI_OUTPUT_ATTACHMENT_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES, ABSOLUTE_MAX_TOTAL_BYTES);
    const maxBytes = boundedConfiguration("AI_OUTPUT_ATTACHMENT_MAX_BYTES", DEFAULT_MAX_ATTACHMENT_BYTES, maxTotalBytes);
    const maxAttachments = boundedConfiguration("AI_OUTPUT_ATTACHMENT_MAX_COUNT", DEFAULT_MAX_ATTACHMENTS, DISCORD_MAX_ATTACHMENTS);
    const attachments = [];
    const warnings = [];
    const seen = new Set();
    let totalBytes = 0;
    for (const requestedPath of requestedPaths) {
        const resolvedIdentity = path.resolve(run.workingDirectory, requestedPath.trim());
        const identity = process.platform === "win32" ? resolvedIdentity.toLowerCase() : resolvedIdentity;
        if (seen.has(identity))
            continue;
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
        if (result.warning)
            warnings.push(result.warning);
    }
    const visibleContent = [text || (attachments.length ? "📎 Attached file(s)." : "(no response)"), ...warnings]
        .filter(Boolean)
        .join("\n\n");
    return { content: visibleContent, attachments };
}
export async function captureAgentArtifacts(workingDirectory, operation) {
    const run = createArtifactRun(workingDirectory);
    try {
        return await prepareAgentResponse(await operation(run), run);
    }
    finally {
        removeEmptyArtifactRun(run);
    }
}
