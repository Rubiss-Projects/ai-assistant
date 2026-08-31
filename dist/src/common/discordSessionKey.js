export function interactionSessionKey(interaction) {
    if (interaction.channel?.isThread())
        return interaction.channelId;
    if (interaction.guildId)
        return `${interaction.user.id}:${interaction.channelId}`;
    return interaction.user.id;
}
export function interactionSessionLabel(interaction) {
    if (interaction.channel?.isThread())
        return "this thread";
    if (interaction.guildId)
        return "your session in this channel";
    return "your DM session";
}
