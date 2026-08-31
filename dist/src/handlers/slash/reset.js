import { interactionSessionKey, interactionSessionLabel } from "../../common/discordSessionKey.js";
export async function handleReset(interaction, sessions) {
    try {
        const sessionKey = interactionSessionKey(interaction);
        const scope = `${interactionSessionLabel(interaction)} (${sessions.activeProviderDisplayName(sessionKey)})`;
        await sessions.resetSession(sessionKey);
        await interaction.reply({
            content: `✅ ${scope} has been reset.`,
            ephemeral: true,
        });
    }
    catch (err) {
        console.error("[/reset] Error:", err);
        await interaction.reply({
            content: "❌ Failed to reset session. Please try again.",
            ephemeral: true,
        });
    }
}
