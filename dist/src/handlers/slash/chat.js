import { ThreadAutoArchiveDuration } from "discord.js";
import { chunkForDiscord } from "../../sessionManager.js";
import { prepareSlashAttachments } from "../../utils/prepareSlashAttachments.js";
export async function handleChat(interaction, sessions, canIncludeContextAuthor = () => true) {
    const message = interaction.options.getString("message", true);
    const workspace = interaction.options.getString("workspace", false);
    const imageAttachment = interaction.options.getAttachment("image", false);
    // DMs can't have threads — treat the whole DM as one persistent session
    if (interaction.channel?.isDMBased()) {
        try {
            await interaction.deferReply();
            // Resolve after defer to avoid hitting Discord's 3s interaction window
            const prepared = await prepareSlashAttachments(message, interaction.client, interaction.user.id, imageAttachment, interaction, canIncludeContextAuthor, (internalPrompt) => sessions.runEphemeral(interaction.user.id, internalPrompt));
            let response;
            try {
                if (workspace)
                    sessions.setSessionWorkingDir(interaction.user.id, workspace);
                response = await sessions.sendMessage(interaction.user.id, prepared.prompt, prepared.attachments.length ? prepared.attachments : undefined);
            }
            finally {
                await prepared.cleanup();
            }
            const chunks = chunkForDiscord(response);
            await interaction.editReply(chunks[0]);
            for (const chunk of chunks.slice(1)) {
                await interaction.followUp({ content: chunk });
            }
        }
        catch (err) {
            console.error("[/chat DM] Error:", err);
            const isPathError = err instanceof Error && err.message.startsWith("Workspace path") || err instanceof Error && err.message === "Invalid workspace path.";
            const msg = isPathError
                ? `❌ Invalid workspace: ${err.message}`
                : "❌ Something went wrong talking to the AI. Please try again.";
            if (interaction.deferred) {
                await interaction.editReply(msg).catch(() => { });
            }
            else {
                await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
            }
        }
        return;
    }
    // Channel: spawn a public thread — each /chat gets its own isolated context.
    // If already inside a thread, reuse it instead of trying to nest threads.
    try {
        await interaction.deferReply();
        // Resolve after defer to avoid hitting Discord's 3s interaction window
        const prepared = await prepareSlashAttachments(message, interaction.client, interaction.user.id, imageAttachment, interaction, canIncludeContextAuthor, (internalPrompt) => sessions.runEphemeral(interaction.channelId, internalPrompt));
        try {
            if (interaction.channel?.isThread()) {
                // Can't create a thread inside a thread — use the current thread as the session
                if (workspace)
                    sessions.setSessionWorkingDir(interaction.channelId, workspace);
                const response = await sessions.sendMessage(interaction.channelId, prepared.prompt, prepared.attachments.length ? prepared.attachments : undefined);
                const chunks = chunkForDiscord(response);
                await interaction.editReply(chunks[0]);
                for (const chunk of chunks.slice(1)) {
                    await interaction.followUp({ content: chunk });
                }
                return;
            }
            const replyMsg = await interaction.fetchReply();
            const safeName = message.replace(/[\r\n]+/g, " ");
            const threadName = `${sessions.activeProviderDisplayName(interaction.user.id)}: ${safeName.slice(0, 50)}${safeName.length > 50 ? "…" : ""}`;
            const thread = await replyMsg.startThread({
                name: threadName,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
            });
            // Session keyed by thread ID — fully isolated per conversation
            if (workspace)
                sessions.setSessionWorkingDir(thread.id, workspace);
            const response = await sessions.sendMessage(thread.id, prepared.prompt, prepared.attachments.length ? prepared.attachments : undefined);
            for (const chunk of chunkForDiscord(response)) {
                await thread.send(chunk);
            }
            await interaction.editReply(`💬 ${thread.toString()}`);
        }
        finally {
            await prepared.cleanup();
        }
    }
    catch (err) {
        console.error("[/chat] Error:", err);
        const isPathError = err instanceof Error && (err.message.startsWith("Workspace path") || err.message === "Invalid workspace path.");
        const msg = isPathError
            ? `❌ Invalid workspace: ${err.message}`
            : "❌ Something went wrong talking to the AI. Please try again.";
        if (interaction.deferred) {
            await interaction.editReply(msg).catch(() => { });
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
        }
    }
}
