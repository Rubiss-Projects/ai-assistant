import { chunkForDiscord, runTimeoutMessage } from "../../sessionManager.js";
import { prepareSlashAttachments } from "../../utils/prepareSlashAttachments.js";
import { progressMessage } from "../../common/progressMessage.js";
export async function handleAsk(interaction, sessions, canIncludeContextAuthor = () => true) {
    const prompt = interaction.options.getString("prompt", true);
    const workspace = interaction.options.getString("workspace", false);
    const imageAttachment = interaction.options.getAttachment("image", false);
    const tempKey = `ask_tmp_${interaction.user.id}_${Date.now()}`;
    try {
        await interaction.deferReply({ ephemeral: true });
        let response;
        try {
            if (workspace)
                sessions.setSessionWorkingDir(tempKey, workspace);
            const prepared = await prepareSlashAttachments(prompt, interaction.client, interaction.user.id, imageAttachment, interaction, canIncludeContextAuthor, (internalPrompt) => sessions.runEphemeral(tempKey, internalPrompt));
            try {
                response = await sessions.sendMessage(tempKey, prepared.prompt, prepared.attachments.length ? prepared.attachments : undefined, { onProgress: ({ elapsedMs }) => interaction.editReply(progressMessage(elapsedMs)).then(() => { }) });
            }
            finally {
                // Temp file cleanup is independent of session reset — always run both
                await prepared.cleanup();
            }
        }
        finally {
            // Always clean up the temp session, even on error
            await sessions.resetSession(tempKey);
        }
        const chunks = chunkForDiscord(response);
        await interaction.editReply(chunks[0]);
        for (const chunk of chunks.slice(1)) {
            await interaction.followUp({ ephemeral: true, content: chunk });
        }
    }
    catch (err) {
        console.error("[/ask] Error:", err);
        const msg = runTimeoutMessage(err) ?? "❌ Something went wrong talking to the AI. Please try again.";
        if (interaction.deferred) {
            await interaction.editReply(msg).catch(() => { });
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
        }
    }
}
