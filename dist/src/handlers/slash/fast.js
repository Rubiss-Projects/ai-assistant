import { isUnsupported } from "../../sessionManager.js";
import { interactionSessionKey } from "../../common/discordSessionKey.js";
export async function handleFast(interaction, sessions) {
    await interaction.deferReply({ ephemeral: true });
    try {
        const key = interactionSessionKey(interaction);
        const setting = interaction.options.getSubcommand(true) === "set";
        if (setting)
            await sessions.setFastMode(key, interaction.options.getBoolean("enabled", true));
        const enabled = await sessions.getFastMode(key);
        await interaction.editReply(`Fast mode: **${enabled ? "on" : "off"}**.${setting ? " Takes effect on the next message." : ""}`);
    }
    catch (error) {
        console.error("[/fast] Error:", error);
        await interaction.editReply(isUnsupported(error) ? error.message : "Failed to update or read fast mode. Please try again.");
    }
}
