export async function handleStatus(interaction, sessions) {
    try {
        await interaction.deferReply({ ephemeral: true });
        const sessionKey = interaction.channel?.isThread()
            ? interaction.channelId
            : interaction.user.id;
        const { status, authStatus } = await sessions.getStatus(sessionKey);
        const authLine = authStatus.isAuthenticated
            ? `✅ Authenticated as **${authStatus.login ?? "unknown"}** via \`${authStatus.authType}\` on \`${authStatus.host ?? "github.com"}\``
            : `❌ Not authenticated — ${authStatus.statusMessage ?? "unknown reason"}`;
        await interaction.editReply(`**${sessions.activeProviderDisplayName(sessionKey)} Status**\n${authLine}\nCLI version: \`${status.version}\`\nProvider: \`${sessions.activeProviderName(sessionKey)}\``);
    }
    catch (err) {
        console.error("[/status] Error:", err);
        const msg = "❌ Failed to retrieve status. Please try again.";
        if (interaction.deferred) {
            await interaction.editReply(msg);
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
}
