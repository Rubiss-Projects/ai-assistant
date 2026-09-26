import { downloadFileAttachments, prepareDownloadedAttachments } from "./downloadAttachments.js";
import { resolveMessageLinks } from "./resolveMessageLinks.js";
import { enrichDiscordRequest } from "./discordKnowledge.js";
export async function prepareSlashAttachments(prompt, client, requestingUserId, directAttachment, interaction, canIncludeContextAuthor = () => true, infer, contextAttachments = []) {
    const linkedAttachments = [];
    const knowledge = interaction
        ? await enrichDiscordRequest(interaction, prompt, client, canIncludeContextAuthor, infer)
        : { prompt, isChannelSummary: false };
    const enrichedPrompt = knowledge.isChannelSummary ? knowledge.prompt : await resolveMessageLinks(knowledge.prompt, client, requestingUserId, linkedAttachments, canIncludeContextAuthor, prompt);
    const result = await downloadFileAttachments([
        ...(directAttachment ? [directAttachment] : []),
        ...linkedAttachments,
        ...(knowledge.isChannelSummary ? [] : contextAttachments),
    ]);
    try {
        const prepared = await prepareDownloadedAttachments(result.attachments);
        return {
            isChannelSummary: knowledge.isChannelSummary,
            prompt: [enrichedPrompt, prepared.textContext, ...result.warnings.map((warning) => `[Input attachment unavailable: ${warning}]`)].filter(Boolean).join("\n\n"),
            attachments: prepared.fileAttachments,
            cleanup: result.cleanup,
        };
    }
    catch (error) {
        await result.cleanup();
        throw error;
    }
}
