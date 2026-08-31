import { ChatInputCommandInteraction } from "discord.js";
import { SessionManager } from "../../sessionManager.js";
import { interactionSessionKey, interactionSessionLabel } from "../../common/discordSessionKey.js";

export async function handleReset(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager
): Promise<void> {
  try {
    const sessionKey = interactionSessionKey(interaction);
    const scope = `${interactionSessionLabel(interaction)} (${sessions.activeProviderDisplayName(sessionKey)})`;
    await sessions.resetSession(sessionKey);
    await interaction.reply({
      content: `✅ ${scope} has been reset.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error("[/reset] Error:", err);
    await interaction.reply({
      content: "❌ Failed to reset session. Please try again.",
      ephemeral: true,
    });
  }
}
