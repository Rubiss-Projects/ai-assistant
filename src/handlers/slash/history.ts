import { ChatInputCommandInteraction } from "discord.js";
import { SessionManager, chunkForDiscord } from "../../sessionManager.js";
import { interactionSessionKey } from "../../common/discordSessionKey.js";

export async function handleHistory(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager
): Promise<void> {
  try {
    await interaction.deferReply({ ephemeral: true });

    const sessionKey = interactionSessionKey(interaction);
    const events = await sessions.getHistory(sessionKey);
    if (!events) {
      await interaction.editReply("No active session. Start chatting first with `/chat`.");
      return;
    }

    const count = interaction.options.getInteger("count") ?? 5;

    // Extract only user and top-level assistant messages (skip sub-agent turns)
    const exchanges = events.filter(
      (e) =>
        (e.type === "user.message" || e.type === "assistant.message") &&
        !(e.type === "assistant.message" && e.data.parentToolCallId)
    );

    const recent = exchanges.slice(-(count * 2)); // 2 events per exchange

    if (recent.length === 0) {
      await interaction.editReply("No messages in your session yet.");
      return;
    }

    const lines = recent.map((e) => {
      if (e.type === "user.message") {
        return `**You:** ${e.data.content}`;
      } else {
        // assistant.message
        return `**${sessions.activeProviderDisplayName(sessionKey)}:** ${e.data.content}`;
      }
    });

    const chunks = chunkForDiscord(lines.join("\n\n"));
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ ephemeral: true, content: chunk });
    }
  } catch (err) {
    console.error("[/history] Error:", err);
    const msg = "❌ Failed to retrieve history. Please try again.";
    if (interaction.deferred) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
}
