export async function discordSubject(client, userId, guildId) {
    if (!guildId)
        return { userId };
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch({ user: userId, force: true });
    return { userId, guildId, roleIds: [...member.roles.cache.keys()] };
}
/** Existing context filters are synchronous. Unknown role membership is excluded. */
export function contextAuthorPolicy(access, client, guildId) {
    return userId => access.canMessage(userId, {
        userId, guildId,
        roleIds: guildId ? [...(client.guilds.cache.get(guildId)?.members.cache.get(userId)?.roles.cache.keys() ?? [])] : [],
    });
}
