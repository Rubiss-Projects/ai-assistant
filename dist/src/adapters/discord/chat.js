import { ChatInputCommandInteraction, Message, ThreadAutoArchiveDuration } from 'discord.js';
import { SessionManager, runTimeoutMessage } from '../../sessionManager.js';
import { chunkForDiscord } from '../../common/chunkForDiscord.js';
import { executeDiscordTurn } from './turn.js';
import { channelHistoryResolver } from '../../utils/channelSummary.js';
import { artifactMessageResolver } from '../../utils/artifactMessage.js';
import { prepareSlashAttachments } from '../../utils/prepareSlashAttachments.js';
import { progressMessage } from '../../common/progressMessage.js';
import { interactionSessionKey } from '../../common/discordSessionKey.js';
import { deliverDiscordAttachments, discordTextOptions } from '../../common/discordResponse.js';
import { participationAttachments, participationReplyContext } from '../../common/discordParticipation.js';
import { userVisibleErrorMessage } from '../../common/userVisibleError.js';
export async function handleChat(interaction, sessions, canIncludeContextAuthor = ()=>true, runThreadTurn = (_key, run)=>run(), threadContext, rulesetContext) {
    const message = interaction.options.getString('message', true);
    const workspace = interaction.options.getString('workspace', false);
    const imageAttachment = interaction.options.getAttachment('image', false);
    let durableReply;
    let createdThread;
    const direct = Boolean(interaction.channel?.isDMBased());
    const existingThread = Boolean(interaction.channel?.isThread());
    const key = direct ? interaction.user.id : existingThread ? interactionSessionKey(interaction) : 'discord-chat:' + interaction.id;
    try {
        await interaction.deferReply();
        await interaction.editReply('⏳ Preparing your conversation…');
        durableReply = await interaction.fetchReply();
        const run = ()=>executeDiscordTurn(sessions, interaction, key, message, undefined, {
                rulesetContext,
                userInstructionContext: {
                    guildId: interaction.guildId,
                    userId: interaction.user.id,
                    userDisplayName: interaction.user.displayName ?? interaction.user.username
                },
                resolveChannelHistory: channelHistoryResolver(interaction, interaction.client, canIncludeContextAuthor),
                resolveArtifactMessage: artifactMessageResolver(interaction.client, interaction.user.id, canIncludeContextAuthor),
                onProgress: async ({ elapsedMs })=>{
                    await durableReply.edit(progressMessage(elapsedMs));
                }
            }, async (response, destination)=>{
                const chunks = chunkForDiscord(response.content);
                if (!direct && !existingThread) {
                    const thread = createdThread ?? await interaction.client.channels.fetch(destination);
                    if (!thread?.isThread()) throw new Error('Conversation thread is unavailable.');
                    for (const chunk of chunks)await thread.send(discordTextOptions(chunk));
                    await deliverDiscordAttachments((options)=>thread.send(options), response.attachments);
                    await durableReply.edit(`💬 ${thread.toString()}`);
                } else {
                    await durableReply.edit(discordTextOptions(chunks[0]));
                    for (const chunk of chunks.slice(1))await durableReply.reply(discordTextOptions(chunk));
                    await deliverDiscordAttachments((options)=>durableReply.reply(options), response.attachments);
                }
            }, async (destination)=>{
                if (workspace) sessions.setSessionWorkingDir(destination, workspace);
                const context = existingThread && threadContext ? await threadContext(durableReply) : [];
                const prepared = await prepareSlashAttachments(message, interaction.client, interaction.user.id, imageAttachment, interaction, canIncludeContextAuthor, (internal)=>sessions.runEphemeral(destination, internal), participationAttachments(context));
                return {
                    prompt: !prepared.isChannelSummary && context.length ? `${participationReplyContext(context, [
                        durableReply.id
                    ])}\n\nCurrent speaker: ${interaction.user.id}\n${prepared.prompt}` : prepared.prompt,
                    attachments: prepared.attachments.length ? prepared.attachments : undefined,
                    cleanup: prepared.cleanup
                };
            }, !direct && !existingThread ? async ()=>{
                const safeName = message.replace(/[\r\n]+/g, ' ');
                createdThread = await durableReply.startThread({
                    name: `${sessions.activeProviderDisplayName(interaction.user.id)}: ${safeName.slice(0, 50)}${safeName.length > 50 ? '…' : ''}`,
                    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
                });
                return createdThread.id;
            } : undefined);
        if (existingThread) await runThreadTurn(key, run);
        else await run();
    } catch (err) {
        console.error('[/chat] Error:', err);
        const isPathError = err instanceof Error && (err.message.startsWith('Workspace path') || err.message === 'Invalid workspace path.');
        const failure = userVisibleErrorMessage(err) ?? runTimeoutMessage(err) ?? (isPathError ? `❌ Invalid workspace: ${err.message}` : '❌ Something went wrong talking to the AI. Please try again.');
        if (durableReply) await durableReply.edit(failure).catch(()=>{});
        else if (interaction.deferred) await interaction.editReply(failure).catch(()=>{});
        else await interaction.reply({
            content: failure,
            ephemeral: true
        }).catch(()=>{});
    }
}
