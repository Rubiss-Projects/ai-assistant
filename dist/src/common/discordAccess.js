export async function discordSubject(client, userId, guildId, signal) {
    signal?.throwIfAborted();
    if (!guildId)
        return { userId };
    const lookup = async () => {
        const guild = await client.guilds.fetch(guildId);
        signal?.throwIfAborted();
        const member = await guild.members.fetch({ user: userId, force: true });
        signal?.throwIfAborted();
        return { userId, guildId, roleIds: [...member.roles.cache.keys()] };
    };
    if (!signal)
        return lookup();
    // Discord's SDK fetch has no signal option; stop waiting without starting later requests.
    let abort;
    const cancelled = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([lookup(), cancelled]);
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
/** Existing context filters are synchronous. Unknown role membership is excluded. */
export function contextAuthorPolicy(access, client, guildId) {
    return userId => access.canMessage(userId, {
        userId, guildId,
        roleIds: guildId ? [...(client.guilds.cache.get(guildId)?.members.cache.get(userId)?.roles.cache.keys() ?? [])] : [],
    });
}
