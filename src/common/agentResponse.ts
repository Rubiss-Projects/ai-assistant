import fs from "node:fs";
import path from "node:path";
import { configuredMilliseconds } from "./runLifecycle.js";
import { workspacePathIsAllowed } from "./providerSecurity.js";
import type { AgentResponse, ResponseAttachment } from "../providers/types.js";

export const ARTIFACT_INSTRUCTIONS = [
  "When you create a file that the user explicitly asked to download or view, include one marker on its own line at the end of your final response:",
  "[[artifact:relative/path/to/file]]",
  "Use a path relative to the assigned workspace. Include only completed output artifacts, not every file edited during ordinary coding work.",
  "For generated images, reports, archives, or requested patch files, save the output in the workspace and include the marker.",
].join(" ");

const ARTIFACT_MARKER = /^\s*\[\[artifact:(.+?)\]\]\s*$/gim;
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 10;

function safeDisplayName(candidate: string): string {
  return path.basename(candidate).replace(/[\r\n\0]/g, "_") || "attachment";
}

function attachmentWarning(name: string, reason: string): string {
  return `⚠️ Could not attach \`${safeDisplayName(name)}\`: ${reason}`;
}

function loadAttachment(
  workingDirectory: string,
  requestedPath: string,
  maxBytes: number,
): { attachment?: ResponseAttachment; warning?: string } {
  const trimmed = requestedPath.trim();
  const displayName = safeDisplayName(trimmed);
  if (!trimmed || trimmed.includes("\0")) {
    return { warning: attachmentWarning(displayName, "the path is invalid.") };
  }
  if (!workspacePathIsAllowed(workingDirectory, trimmed)) {
    return { warning: attachmentWarning(displayName, "the path is outside the allowed workspace.") };
  }

  const absolutePath = path.resolve(workingDirectory, trimmed);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch {
    return { warning: attachmentWarning(displayName, "the file does not exist.") };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { warning: attachmentWarning(displayName, "only regular files can be attached.") };
  }
  if (stats.size > maxBytes) {
    return {
      warning: attachmentWarning(
        displayName,
        `it exceeds the configured ${maxBytes}-byte limit.`,
      ),
    };
  }

  try {
    const data = fs.readFileSync(absolutePath);
    const afterRead = fs.lstatSync(absolutePath);
    if (!afterRead.isFile() || afterRead.isSymbolicLink() || afterRead.size !== data.byteLength) {
      return { warning: attachmentWarning(displayName, "the file changed while it was being read.") };
    }
    return { attachment: { data, displayName } };
  } catch {
    return { warning: attachmentWarning(displayName, "the file could not be read.") };
  }
}

/**
 * Convert explicit agent artifact markers into bounded in-memory attachments.
 * Reading bytes here prevents path swaps or workspace cleanup from changing what
 * Discord receives later in the delivery pipeline.
 */
export function prepareAgentResponse(content: string, workingDirectory: string): AgentResponse {
  const requestedPaths: string[] = [];
  const text = content.replace(ARTIFACT_MARKER, (_marker, requestedPath: string) => {
    requestedPaths.push(requestedPath);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();

  const maxBytes = configuredMilliseconds(
    "AI_OUTPUT_ATTACHMENT_MAX_BYTES",
    DEFAULT_MAX_ATTACHMENT_BYTES,
    1,
  );
  const maxAttachments = configuredMilliseconds(
    "AI_OUTPUT_ATTACHMENT_MAX_COUNT",
    DEFAULT_MAX_ATTACHMENTS,
    1,
  );
  const attachments: ResponseAttachment[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const requestedPath of requestedPaths) {
    const resolvedIdentity = path.resolve(workingDirectory, requestedPath.trim());
    const identity = process.platform === "win32" ? resolvedIdentity.toLowerCase() : resolvedIdentity;
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (attachments.length >= maxAttachments) {
      warnings.push(attachmentWarning(requestedPath, `only ${maxAttachments} attachments are allowed per response.`));
      continue;
    }
    const result = loadAttachment(workingDirectory, requestedPath, maxBytes);
    if (result.attachment) attachments.push(result.attachment);
    if (result.warning) warnings.push(result.warning);
  }

  const visibleContent = [text || (attachments.length ? "📎 Attached file(s)." : "(no response)"), ...warnings]
    .filter(Boolean)
    .join("\n\n");
  return { content: visibleContent, attachments };
}
