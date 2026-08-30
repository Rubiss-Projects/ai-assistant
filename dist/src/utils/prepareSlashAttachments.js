import { downloadFileAttachments, prepareDownloadedAttachments } from "./downloadAttachments.js";
import { resolveMessageLinks } from "./resolveMessageLinks.js";
export async function prepareSlashAttachments(prompt, client, requestingUserId, directAttachment) {
    const linkedAttachments = [];
    const enrichedPrompt = await resolveMessageLinks(prompt, client, requestingUserId, linkedAttachments);
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
