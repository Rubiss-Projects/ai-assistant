import type { ResponseAttachment } from "../providers/types.js";

export function discordResponseOptions(content: string, attachments: ResponseAttachment[] = []) {
  return {
    content,
    files: attachments.map((attachment) => ({
      attachment: attachment.data,
      name: attachment.displayName,
    })),
  };
}
