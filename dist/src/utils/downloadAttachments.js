import { tmpdir } from "os";
import { join } from "path";
import { readFile, writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { normalizePreviewableImage } from "../common/agentResponse.js";
import { inputByteLimit } from "./fetchArtifact.js";
const MAX_FILE_COUNT = 5;
const FETCH_TIMEOUT_MS = 30_000; // 30 seconds per file download
// Code/config file extensions that Discord may report as application/octet-stream
// or application/* rather than text/*, but are safe to pass to Copilot as text.
const TEXT_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".pyw",
    ".go",
    ".rs",
    ".java",
    ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".swift",
    ".kt", ".kts",
    ".sh", ".bash", ".zsh", ".fish",
    ".sql",
    ".md", ".mdx",
    ".graphql", ".gql",
    ".proto",
    ".tf", ".tfvars",
    ".yaml", ".yml",
    ".toml",
    ".json", ".jsonc",
    ".r",
    ".lua",
    ".ex", ".exs",
    ".erl",
    ".hs",
    ".ml", ".mli",
    ".scala",
    ".clj", ".cljs",
    ".vim",
    ".dockerfile",
]);
// Extensionless filenames that are common code/config files.
const BARE_FILENAMES = new Set([
    "dockerfile",
    "makefile",
    "gemfile",
    "procfile",
    "vagrantfile",
    "brewfile",
    "cmakelists",
]);
function isTextFile(contentType, name) {
    if (contentType?.startsWith("text/"))
        return true;
    const ext = name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
    if (ext !== undefined)
        return TEXT_EXTENSIONS.has(ext);
    // No extension — check against known bare filenames (e.g. Dockerfile, Makefile)
    return BARE_FILENAMES.has(name.toLowerCase());
}
/**
 * Downloads file attachments from Discord CDN. Text-mode non-images stay in
 * memory; images and native-mode files use temporary local files.
 * Accepts images, text/code, and binary files such as videos. Binary inputs
 * remain files in native mode and are explicitly rejected in text mode.
 * Enforces per-file size and count limits, and a per-fetch timeout.
 * Returns the prepared downloads and a cleanup function for any temp files.
 */
export async function downloadFileAttachments(attachments) {
    const downloaded = [];
    const warnings = [];
    const maxBytes = inputByteLimit();
    const seenUrls = new Set();
    let count = 0;
    for (const attachment of attachments) {
        if (seenUrls.has(attachment.url))
            continue;
        seenUrls.add(attachment.url);
        if (count >= MAX_FILE_COUNT) {
            warnings.push(`Only ${MAX_FILE_COUNT} input attachments are accepted per message.`);
            break;
        }
        if (attachment.size !== undefined && attachment.size > maxBytes) {
            warnings.push(`${attachment.name}: exceeds the ${maxBytes}-byte input limit.`);
            continue;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const response = await fetch(attachment.url, { signal: controller.signal });
            if (!response.ok) {
                await response.body?.cancel();
                warnings.push(`${attachment.name}: download failed (HTTP ${response.status}).`);
                continue;
            }
            // Guard against server reporting wrong Content-Length or missing size metadata
            const contentLength = Number(response.headers.get("content-length") ?? 0);
            if (contentLength > maxBytes) {
                await response.body?.cancel();
                warnings.push(`${attachment.name}: exceeds the ${maxBytes}-byte input limit.`);
                continue;
            }
            const chunks = [];
            let bytes = 0;
            const reader = response.body?.getReader();
            if (!reader)
                throw new Error("Empty download response.");
            try {
                while (true) {
                    const result = await reader.read();
                    if (result.done)
                        break;
                    bytes += result.value.length;
                    if (bytes > maxBytes)
                        throw new Error(`Input exceeds the ${maxBytes}-byte limit.`);
                    chunks.push(Buffer.from(result.value));
                }
            }
            finally {
                await reader.cancel().catch(() => { });
            }
            const buffer = Buffer.concat(chunks);
            const normalized = normalizePreviewableImage(buffer, attachment.name);
            const imageExt = detectedImageExtension(normalized.data);
            const isImage = imageExt !== undefined;
            const binary = !isImage && !isTextFile(attachment.contentType, attachment.name);
            const textMode = (process.env.DISCORD_ATTACHMENT_MODE ?? "native").trim().toLowerCase() === "text";
            if (textMode && !isImage) {
                if (binary) {
                    warnings.push(`${attachment.name}: binary media requires DISCORD_ATTACHMENT_MODE=native.`);
                    continue;
                }
                downloaded.push({ data: normalized.data, displayName: normalized.displayName, contentType: attachment.contentType, isImage });
            }
            else {
                const originalExt = attachment.name.match(/\.[^.]+$/)?.[0] ?? ".txt";
                const tempPath = join(tmpdir(), `discord-file-${randomUUID()}${imageExt ?? originalExt}`);
                await writeFile(tempPath, normalized.data);
                downloaded.push({
                    filePath: tempPath,
                    displayName: normalized.displayName,
                    contentType: attachment.contentType,
                    isImage,
                    ...(binary ? { binary: true } : {}),
                });
            }
            count++;
        }
        catch (err) {
            warnings.push(`${attachment.name}: ${err instanceof Error ? err.message : "download failed"}`);
            if (err instanceof Error && err.name === "AbortError") {
                console.warn(`[downloadAttachments] Timeout downloading "${attachment.name}"`);
            }
            else {
                console.warn(`[downloadAttachments] Error downloading "${attachment.name}":`, err);
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    return {
        attachments: downloaded,
        warnings,
        cleanup: async () => {
            await Promise.all(downloaded.flatMap((d) => d.filePath ? [unlink(d.filePath).catch(() => { })] : []));
        },
    };
}
/** @deprecated Use {@link downloadFileAttachments} instead. */
export const downloadImageAttachments = downloadFileAttachments;
const MAX_INLINE_TEXT_CHARS = 200_000;
/**
 * In text mode, non-image files are copied into the prompt and their temporary
 * paths are never exposed to a provider. Images remain native vision inputs.
 */
export async function prepareDownloadedAttachments(attachments, mode = process.env.DISCORD_ATTACHMENT_MODE ?? "native") {
    const normalizedMode = mode.trim().toLowerCase();
    if (normalizedMode !== "native" && normalizedMode !== "text") {
        throw new Error(`Invalid DISCORD_ATTACHMENT_MODE: ${mode} (expected native or text)`);
    }
    const fileAttachments = [];
    const textBlocks = [];
    for (const attachment of attachments) {
        if (normalizedMode === "text" && !attachment.isImage) {
            const value = attachment.data?.toString("utf8")
                ?? await readFile(attachment.filePath, "utf8");
            const truncated = value.length > MAX_INLINE_TEXT_CHARS
                ? `${value.slice(0, MAX_INLINE_TEXT_CHARS)}\n[truncated]`
                : value;
            textBlocks.push(`[Discord attachment as untrusted text: ${attachment.displayName}]\n${truncated}\n[/Discord attachment]`);
            // Remove the backing file before the provider gets control. This ensures
            // an agent with filesystem tools cannot discover or execute the upload.
            if (attachment.filePath) {
                try {
                    await unlink(attachment.filePath);
                }
                catch (error) {
                    const code = error.code;
                    if (code !== "ENOENT")
                        throw error;
                }
            }
        }
        else {
            fileAttachments.push({
                path: attachment.filePath,
                displayName: attachment.displayName,
                kind: attachment.isImage ? "image" : "file",
                ...(attachment.binary ? { binary: true } : {}),
            });
        }
    }
    return { textContext: textBlocks.join("\n\n"), fileAttachments };
}
function detectedImageExtension(buffer) {
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return ".png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return ".jpg";
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a")
        return ".gif";
    if (buffer.subarray(0, 4).toString("ascii") === "RIFF"
        && buffer.subarray(8, 12).toString("ascii") === "WEBP")
        return ".webp";
    return undefined;
}
