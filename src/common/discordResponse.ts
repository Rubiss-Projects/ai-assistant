import { createHash } from "node:crypto";
import { MessageFlags } from "discord.js";
import type { ResponseAttachment } from "../providers/types.js";

/** Hide link previews without rewriting URLs or changing notification behavior. */
export function discordEmbedOptions(): { flags?: MessageFlags.SuppressEmbeds } {
  return process.env.DISCORD_SUPPRESS_EMBEDS?.trim().toLowerCase() === "true"
    ? { flags: MessageFlags.SuppressEmbeds }
    : {};
}

export function discordTextOptions(content: string) {
  return { content, files: [], ...discordEmbedOptions() };
}

/** Send artifacts separately so a rejected upload can never suppress the text response. */
export async function deliverDiscordAttachments(
  send: (options: { content: string; files: Array<{ attachment: Buffer; name: string }> }) => Promise<unknown>,
  attachments: ResponseAttachment[],
): Promise<void> {
  const deliveredContent = new Set<string>();
  for (const attachment of attachments) {
    const contentIdentity = createHash("sha256").update(attachment.data).digest("hex");
    if (deliveredContent.has(contentIdentity)) continue;
    deliveredContent.add(contentIdentity);
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
