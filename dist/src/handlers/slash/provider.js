function sessionScope(interaction) {
    return interaction.channel?.isThread()
        ? { key: interaction.channelId, label: "this thread" }
        : { key: interaction.user.id, label: "your session" };
}
export async function handleProvider(interaction, sessions) {
    const sub = interaction.options.getSubcommand(true);
    const scope = sessionScope(interaction);
    try {
        await interaction.deferReply({ ephemeral: true });
        if (sub === "list") {
            const available = sessions.listAvailableProviders();
            const active = sessions.activeProviderName(scope.key);
            const items = available.map((name) => {
                const isActive = name === active ? " ✅ (active)" : "";
                const isDefault = name === sessions.name ? " (default)" : "";
                return `• \`${name}\`${isActive}${isDefault}`;
            });
            await interaction.editReply(`**Available providers:**\n${items.join("\n")}\n\nSet one with \`/provider set\`.`);
        }
        else if (sub === "set") {
            const name = interaction.options.getString("provider", true);
            await sessions.setSessionProvider(scope.key, name);
            await interaction.editReply(`✅ Switched to **${sessions.activeProviderDisplayName(scope.key)}** (\`${name}\`) for ${scope.label}.`);
        }
        else if (sub === "current") {
            const active = sessions.activeProviderName(scope.key);
            const display = sessions.activeProviderDisplayName(scope.key);
            await interaction.editReply(`🧠 Active provider for ${scope.label}: **${display}** (\`${active}\`)`);
        }
    }
    catch (err) {
        console.error(`[/provider ${sub}] Error:`, err);
        const msg = err instanceof Error ? `❌ ${err.message}` : "❌ Failed to manage provider. Please try again.";
        if (interaction.deferred)
            await interaction.editReply(msg).catch(() => { });
        else
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
    }
}
