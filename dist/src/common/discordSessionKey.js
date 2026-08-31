export function interactionSessionKey(interaction) {
    if (interaction.channel?.isThread() && interaction.channel.ownerId === interaction.client.user.id)
        return interaction.channelId;
    if (interaction.guildId)
        return `${interaction.user.id}:${interaction.channelId}`;
    return interaction.user.id;
}
export function interactionSessionLabel(interaction) {
    if (interaction.channel?.isThread() && interaction.channel.ownerId === interaction.client.user.id)
        return "this thread";
    if (interaction.guildId)
        return "your session in this channel";
    return "your DM session";
}
