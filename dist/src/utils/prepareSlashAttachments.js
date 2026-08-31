import { downloadFileAttachments, prepareDownloadedAttachments } from "./downloadAttachments.js";
import { resolveMessageLinks } from "./resolveMessageLinks.js";
import { enrichWithDiscordKnowledge } from "./discordKnowledge.js";
export async function prepareSlashAttachments(prompt, client, requestingUserId, directAttachment, interaction, canIncludeContextAuthor = () => true, infer) {
    const linkedAttachments = [];
    const knowledgePrompt = interaction
        ? await enrichWithDiscordKnowledge(interaction, prompt, client, canIncludeContextAuthor, infer)
        : prompt;
    const enrichedPrompt = await resolveMessageLinks(knowledgePrompt, client, requestingUserId, linkedAttachments);
    const result = await downloadFileAttachments([
        ...(directAttachment ? [directAttachment] : []),
        ...linkedAttachments,
    ]);
    try {
        const prepared = await prepareDownloadedAttachments(result.attachments);
        return {
            prompt: prepared.textContext
                ? `${enrichedPrompt}\n\n${prepared.textContext}`
                : enrichedPrompt,
            attachments: prepared.fileAttachments,
            cleanup: result.cleanup,
        };
    }
    catch (error) {
        await result.cleanup();
        throw error;
    }
}
