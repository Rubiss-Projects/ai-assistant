import { ChatInputCommandInteraction, Message } from "discord.js";
import { SessionManager, chunkForDiscord, runTimeoutMessage } from "../../sessionManager.js";
import { prepareSlashAttachments } from "../../utils/prepareSlashAttachments.js";
import { progressMessage } from "../../common/progressMessage.js";
import { deliverDiscordAttachments, discordTextOptions } from "../../common/discordResponse.js";
import type { AgentResponse } from "../../providers/types.js";
import { userVisibleErrorMessage } from "../../common/userVisibleError.js";

export async function handleAsk(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager,
  canIncludeContextAuthor: (authorId: string) => boolean = () => true,
): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const workspace = interaction.options.getString("workspace", false);
  const imageAttachment = interaction.options.getAttachment("image", false);
  const tempKey = `ask_tmp_${interaction.user.id}_${Date.now()}`;
  let durableReply: Message | undefined;

  try {
    await interaction.deferReply({ ephemeral: true });
    try {
      durableReply = await interaction.user.send("⏳ Working on your request…");
      await interaction.editReply("📬 I’ll deliver the result in our DM so long-running work is not lost.");
    } catch {
      await interaction.editReply("❌ I can’t deliver a long-running private result because your DMs are closed. Enable DMs from this server and try again.");
      return;
    }

    let response: AgentResponse;
    try {
      if (workspace) sessions.setSessionWorkingDir(tempKey, workspace);
      const prepared = await prepareSlashAttachments(
        prompt,
        interaction.client,
        interaction.user.id,
        imageAttachment,
        interaction,
        canIncludeContextAuthor,
        (internalPrompt) => sessions.runEphemeral(tempKey, internalPrompt),
      );

      try {
        response = await sessions.sendMessage(
          tempKey,
          prepared.prompt,
          prepared.attachments.length ? prepared.attachments : undefined,
          { onProgress: ({ elapsedMs }) => durableReply!.edit(progressMessage(elapsedMs)).then(() => {}) },
        );
      } finally {
        // Temp file cleanup is independent of session reset — always run both
        await prepared.cleanup();
      }
    } finally {
      // Always clean up the temp session, even on error
      await sessions.resetSession(tempKey);
    }

    const chunks = chunkForDiscord(response.content);
    await durableReply.edit(discordTextOptions(chunks[0]));
    for (const chunk of chunks.slice(1)) {
      await durableReply.reply(discordTextOptions(chunk));
    }
    await deliverDiscordAttachments((options) => durableReply!.reply(options), response.attachments);
  } catch (err) {
    console.error("[/ask] Error:", err);
    const msg = userVisibleErrorMessage(err) ?? runTimeoutMessage(err) ?? "❌ Something went wrong talking to the AI. Please try again.";
    if (durableReply) {
      await durableReply.edit(msg).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}
