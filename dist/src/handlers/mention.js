import { chunkForDiscord, runTimeoutMessage } from "../sessionManager.js";
import { resolveMessageLinks } from "../utils/resolveMessageLinks.js";
import { resolveDiscordContext } from "../utils/resolveDiscordContext.js";
import { downloadFileAttachments, prepareDownloadedAttachments } from "../utils/downloadAttachments.js";
import { enrichWithDiscordKnowledge } from "../utils/discordKnowledge.js";
import { progressMessage } from "../common/progressMessage.js";
export async function handleMention(message, client, sessions, sessionKey, // defaults to message.author.id; pass channelId for thread sessions
canIncludeContextAuthor = () => true) {
    // Strip all @mentions of the bot and trim
    const botMentionPattern = new RegExp(`<@!?${client.user.id}>`, "g");
    const prompt = message.content.replace(botMentionPattern, "").trim();
    const contextAttachments = [];
    let cleanup = async () => { };
    let typingInterval;
    let progressReply;
    let progressUpdates = Promise.resolve();
    try {
        if (!prompt && message.attachments.size === 0 && !message.reference?.messageId) {
            await message.reply("👋 Hi! Mention me with a question or command. Use `/ask` for one-shot queries, `/chat` for persistent conversation, or `/reset` to clear your history.");
            return;
        }
        const key = sessionKey ?? message.author.id;
        const basePrompt = prompt || (message.reference?.messageId
            ? "Respond using the replied-to conversation context."
            : "See the attached file(s).");
        const knowledgePrompt = await enrichWithDiscordKnowledge(message, basePrompt, client, canIncludeContextAuthor, (internalPrompt) => sessions.runEphemeral(key, internalPrompt));
        const linkedPrompt = await resolveMessageLinks(knowledgePrompt, client, message.author.id, contextAttachments);
        let enrichedPrompt = await resolveDiscordContext(message, linkedPrompt, message.mentions.has(client.user.id), canIncludeContextAuthor, contextAttachments);
        const result = await downloadFileAttachments([
            ...message.attachments.values(),
            ...contextAttachments,
        ]);
        cleanup = result.cleanup;
        const prepared = await prepareDownloadedAttachments(result.attachments);
        if (prepared.textContext)
            enrichedPrompt = `${enrichedPrompt}\n\n${prepared.textContext}`;
        // Keep typing indicator alive every 8s (Discord clears it after ~10s)
        if ("sendTyping" in message.channel) {
            await message.channel.sendTyping();
            typingInterval = setInterval(() => {
                if ("sendTyping" in message.channel) {
                    message.channel.sendTyping().catch(() => { });
                }
            }, 8000);
        }
        const response = await sessions.sendMessage(key, enrichedPrompt, prepared.fileAttachments.length ? prepared.fileAttachments : undefined, {
            onProgress: ({ elapsedMs }) => {
                progressUpdates = progressUpdates.catch(() => { }).then(async () => {
                    const content = progressMessage(elapsedMs);
                    if (progressReply)
                        await progressReply.edit(content);
                    else
                        progressReply = await message.reply(content);
                });
                return progressUpdates;
            },
        });
        await progressUpdates.catch(() => { });
        if (progressReply)
            await progressReply.edit("✅ Finished — posting the result now.").catch(() => { });
        const chunks = chunkForDiscord(response);
        await message.reply(chunks[0]);
        for (const chunk of chunks.slice(1)) {
            await message.reply(chunk);
        }
    }
    catch (err) {
        console.error("[mention] Error:", err);
        const failure = runTimeoutMessage(err) ?? "❌ Something went wrong talking to the AI. Please try again.";
        await progressUpdates.catch(() => { });
        if (progressReply)
            await progressReply.edit(failure).catch(() => message.reply(failure).then(() => { }));
        else
            await message.reply(failure);
    }
    finally {
        clearInterval(typingInterval);
        await cleanup();
    }
}
