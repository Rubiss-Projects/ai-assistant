import { discordConversations } from "../../adapters/discord/turn.js";
import { interactionSessionKey, interactionSessionLabel } from "../../common/discordSessionKey.js";
export async function handleReset(interaction, sessions) {
    try {
        await interaction.deferReply({
            ephemeral: true
        });
        const sessionKey = interactionSessionKey(interaction);
        const scope = `${interactionSessionLabel(interaction)} (${sessions.activeProviderDisplayName(sessionKey)})`;
        await discordConversations(sessions).serial(sessionKey, ()=>sessions.resetSession(sessionKey));
        await interaction.editReply({
            content: `✅ ${scope} has been reset.`
        });
    } catch (err) {
        console.error("[/reset] Error:", err);
        if (interaction.deferred) await interaction.editReply({
            content: "❌ Failed to reset session. Please try again."
        });
        else await interaction.reply({
            content: "❌ Failed to reset session. Please try again.",
            ephemeral: true
        });
    }
}
