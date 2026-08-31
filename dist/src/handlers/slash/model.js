import { chunkForDiscord } from "../../sessionManager.js";
import { interactionSessionKey, interactionSessionLabel } from "../../common/discordSessionKey.js";
export async function handleModel(interaction, sessions) {
    const sub = interaction.options.getSubcommand(true);
    try {
        if (sub === "list") {
            await interaction.deferReply({ ephemeral: true });
            const sessionKey = interactionSessionKey(interaction);
            const models = await sessions.listModels(sessionKey);
            if (models.length === 0) {
                await interaction.editReply("No models available.");
                return;
            }
            const lines = models.map((m) => `\`${m.id}\` — ${m.name}`);
            const chunks = chunkForDiscord(`**Available models:**\n${lines.join("\n")}`);
            await interaction.editReply(chunks[0]);
            for (const chunk of chunks.slice(1)) {
                await interaction.followUp({ ephemeral: true, content: chunk });
            }
        }
        else if (sub === "set") {
            const modelId = interaction.options.getString("model_id", true);
            const sessionKey = interactionSessionKey(interaction);
            await interaction.deferReply({ ephemeral: true });
            await sessions.setModel(sessionKey, modelId);
            await interaction.editReply(`✅ Model switched to \`${modelId}\` for ${interactionSessionLabel(interaction)}. Takes effect on the next message.`);
        }
        else if (sub === "current") {
            const sessionKey = interactionSessionKey(interaction);
            await interaction.deferReply({ ephemeral: true });
            const modelId = await sessions.getCurrentModel(sessionKey);
            const scope = interactionSessionLabel(interaction);
            await interaction.editReply(modelId
                ? `🤖 Current model for ${scope}: \`${modelId}\``
                : `🤖 No model explicitly set for ${scope} (using session default).`);
        }
    }
    catch (err) {
        console.error(`[/model ${sub}] Error:`, err);
        const msg = `❌ Failed to ${sub === "list" ? "list models" : sub === "current" ? "get current model" : "switch model"}. Please try again.`;
        if (interaction.deferred) {
            await interaction.editReply(msg);
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
}
