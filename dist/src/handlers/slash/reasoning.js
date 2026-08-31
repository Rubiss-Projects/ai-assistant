import { isUnsupported } from "../../sessionManager.js";
import { interactionSessionKey, interactionSessionLabel } from "../../common/discordSessionKey.js";
function sessionScope(interaction) {
    return { key: interactionSessionKey(interaction), label: interactionSessionLabel(interaction) };
}
export async function handleReasoning(interaction, sessions) {
    const sub = interaction.options.getSubcommand(true);
    try {
        await interaction.deferReply({ ephemeral: true });
        if (sub === "list") {
            const scope = sessionScope(interaction);
            const efforts = await sessions.listReasoningEfforts(scope.key);
            await interaction.editReply(`**Available reasoning efforts:**\n${efforts.map((effort) => `\`${effort}\``).join(" · ")}`);
        }
        else if (sub === "set") {
            const effort = interaction.options.getString("effort", true);
            const scope = sessionScope(interaction);
            await sessions.setReasoningEffort(scope.key, effort);
            await interaction.editReply(`✅ Reasoning effort switched to \`${effort}\` for ${scope.label}. Takes effect on the next message.`);
        }
        else if (sub === "current") {
            const scope = sessionScope(interaction);
            const effort = await sessions.getCurrentReasoningEffort(scope.key);
            await interaction.editReply(`🧠 Current reasoning effort for ${scope.label}: \`${effort}\``);
        }
    }
    catch (err) {
        console.error(`[/reasoning ${sub}] Error:`, err);
        if (isUnsupported(err)) {
            const msg = `⚠️ ${err.message}`;
            if (interaction.deferred)
                await interaction.editReply(msg).catch(() => { });
            else
                await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
            return;
        }
        const action = sub === "list"
            ? "list reasoning efforts"
            : sub === "current"
                ? "get current reasoning effort"
                : "switch reasoning effort";
        const msg = `❌ Failed to ${action}. Please try again.`;
        if (interaction.deferred) {
            await interaction.editReply(msg);
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
}
