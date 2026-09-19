import { artifactMessageResolver } from "../../utils/artifactMessage.js";
import { ThreadAutoArchiveDuration } from "discord.js";
import { chunkForDiscord, runTimeoutMessage } from "../../sessionManager.js";
import { prepareSlashAttachments } from "../../utils/prepareSlashAttachments.js";
import { progressMessage } from "../../common/progressMessage.js";
import { interactionSessionKey } from "../../common/discordSessionKey.js";
import { deliverDiscordAttachments, discordTextOptions } from "../../common/discordResponse.js";
import { participationAttachments, participationReplyContext } from "../../common/discordParticipation.js";
import { userVisibleErrorMessage } from "../../common/userVisibleError.js";
export async function handleChat(interaction, sessions, canIncludeContextAuthor = () => true, runThreadTurn = (_key, run) => run(), threadContext) {
    const message = interaction.options.getString("message", true);
    const workspace = interaction.options.getString("workspace", false);
    const imageAttachment = interaction.options.getAttachment("image", false);
    let durableReply;
    // DMs can't have threads — treat the whole DM as one persistent session
    if (interaction.channel?.isDMBased()) {
        try {
            await interaction.deferReply();
            // Clear Discord's Loading flag via the interaction webhook before durable bot-token edits.
            await interaction.editReply("⏳ Preparing your conversation…");
            durableReply = await interaction.fetchReply();
            // Resolve after defer to avoid hitting Discord's 3s interaction window
            const prepared = await prepareSlashAttachments(message, interaction.client, interaction.user.id, imageAttachment, interaction, canIncludeContextAuthor, (internalPrompt) => sessions.runEphemeral(interaction.user.id, internalPrompt));
            let response;
            try {
                if (workspace)
                    sessions.setSessionWorkingDir(interaction.user.id, workspace);
                response = await sessions.sendMessage(interaction.user.id, prepared.prompt, prepared.attachments.length ? prepared.attachments : undefined, { resolveArtifactMessage: artifactMessageResolver(interaction.client, interaction.user.id, canIncludeContextAuthor), onProgress: ({ elapsedMs }) => durableReply.edit(progressMessage(elapsedMs)).then(() => { }) });
            }
            finally {
                await prepared.cleanup();
            }
            const chunks = chunkForDiscord(response.content);
            await durableReply.edit(discordTextOptions(chunks[0]));
            for (const chunk of chunks.slice(1)) {
                await durableReply.reply(discordTextOptions(chunk));
            }
            await deliverDiscordAttachments((options) => durableReply.reply(options), response.attachments);
        }
        catch (err) {
            console.error("[/chat DM] Error:", err);
            const isPathError = err instanceof Error && err.message.startsWith("Workspace path") || err instanceof Error && err.message === "Invalid workspace path.";
            const msg = userVisibleErrorMessage(err) ?? runTimeoutMessage(err) ?? (isPathError
                ? `❌ Invalid workspace: ${err.message}`
                : "❌ Something went wrong talking to the AI. Please try again.");
            if (durableReply) {
                await durableReply.edit(msg).catch(() => { });
            }
            else if (interaction.deferred) {
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
        // Clear Discord's Loading flag while the interaction token is fresh.
        await interaction.editReply("⏳ Preparing your conversation…");
        durableReply = await interaction.fetchReply();
        const currentSessionKey = interaction.channel?.isThread()
            ? interactionSessionKey(interaction)
            : interaction.channelId;
        // Resolve direct, linked, and history attachments together so they share limits
        // and URL deduplication. History text stays outside host-side intent processing.
        const prepare = (context = []) => prepareSlashAttachments(message, interaction.client, interaction.user.id, imageAttachment, interaction, canIncludeContextAuthor, (internalPrompt) => sessions.runEphemeral(currentSessionKey, internalPrompt), participationAttachments(context));
        if (interaction.channel?.isThread()) {
            await runThreadTurn(currentSessionKey, async () => {
                if (workspace)
                    sessions.setSessionWorkingDir(currentSessionKey, workspace);
                const context = threadContext ? await threadContext(durableReply) : [];
                const prepared = await prepare(context);
                try {
                    const prompt = context.length
                        ? `${participationReplyContext(context, [durableReply.id])}\n\nCurrent speaker: ${interaction.user.id}\n${prepared.prompt}`
                        : prepared.prompt;
                    const response = await sessions.sendMessage(currentSessionKey, prompt, prepared.attachments.length ? prepared.attachments : undefined, { resolveArtifactMessage: artifactMessageResolver(interaction.client, interaction.user.id, canIncludeContextAuthor), onProgress: ({ elapsedMs }) => durableReply.edit(progressMessage(elapsedMs)).then(() => { }) });
                    const chunks = chunkForDiscord(response.content);
                    await durableReply.edit(discordTextOptions(chunks[0]));
                    for (const chunk of chunks.slice(1)) {
                        await durableReply.reply(discordTextOptions(chunk));
                    }
                    await deliverDiscordAttachments((options) => durableReply.reply(options), response.attachments);
                }
                finally {
                    await prepared.cleanup();
                }
            });
            return;
        }
        const prepared = await prepare();
        try {
            const replyMsg = durableReply;
            const safeName = message.replace(/[\r\n]+/g, " ");
            const threadName = `${sessions.activeProviderDisplayName(interaction.user.id)}: ${safeName.slice(0, 50)}${safeName.length > 50 ? "…" : ""}`;
            const thread = await replyMsg.startThread({
                name: threadName,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
            });
            // Session keyed by thread ID — fully isolated per conversation
            await runThreadTurn(thread.id, async () => {
                if (workspace)
                    sessions.setSessionWorkingDir(thread.id, workspace);
                const response = await sessions.sendMessage(thread.id, prepared.prompt, prepared.attachments.length ? prepared.attachments : undefined, { resolveArtifactMessage: artifactMessageResolver(interaction.client, interaction.user.id, canIncludeContextAuthor), onProgress: ({ elapsedMs }) => replyMsg.edit(progressMessage(elapsedMs)).then(() => { }) });
                const chunks = chunkForDiscord(response.content);
                for (const chunk of chunks) {
                    await thread.send(discordTextOptions(chunk));
                }
                await deliverDiscordAttachments((options) => thread.send(options), response.attachments);
                await replyMsg.edit(`💬 ${thread.toString()}`);
            });
        }
        finally {
            await prepared.cleanup();
        }
    }
    catch (err) {
        console.error("[/chat] Error:", err);
        const isPathError = err instanceof Error && (err.message.startsWith("Workspace path") || err.message === "Invalid workspace path.");
        const msg = userVisibleErrorMessage(err) ?? runTimeoutMessage(err) ?? (isPathError
            ? `❌ Invalid workspace: ${err.message}`
            : "❌ Something went wrong talking to the AI. Please try again.");
        if (durableReply) {
            await durableReply.edit(msg).catch(() => { });
        }
        else if (interaction.deferred) {
            await interaction.editReply(msg).catch(() => { });
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
        }
    }
}
