import type { ResponseAttachment } from "../providers/types.js";

export function discordTextOptions(content: string) {
  return { content, files: [] };
}

/** Send artifacts separately so a rejected upload can never suppress the text response. */
export async function deliverDiscordAttachments(
  send: (options: { content: string; files: Array<{ attachment: Buffer; name: string }> }) => Promise<unknown>,
  attachments: ResponseAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    try {
      await send({
        content: `📎 \`${attachment.displayName}\``,
        files: [{ attachment: attachment.data, name: attachment.displayName }],
      });
    } catch (error) {
      console.warn(`[discord] Could not upload artifact ${attachment.displayName}:`, error);
      await send({
        content: `⚠️ Could not upload \`${attachment.displayName}\`; the text response is still available above.`,
        files: [],
      }).catch((warningError) => {
        console.warn("[discord] Could not report an artifact upload failure:", warningError);
      });
    }
  }
}
