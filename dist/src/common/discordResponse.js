import { createHash } from "node:crypto";
export function discordTextOptions(content) {
    return { content, files: [] };
}
/** Send artifacts separately so a rejected upload can never suppress the text response. */
export async function deliverDiscordAttachments(send, attachments) {
    const deliveredContent = new Set();
    for (const attachment of attachments) {
        const contentIdentity = createHash("sha256").update(attachment.data).digest("hex");
        if (deliveredContent.has(contentIdentity))
            continue;
        deliveredContent.add(contentIdentity);
        try {
            await send({
                content: `📎 \`${attachment.displayName}\``,
                files: [{ attachment: attachment.data, name: attachment.displayName }],
            });
        }
        catch (error) {
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
