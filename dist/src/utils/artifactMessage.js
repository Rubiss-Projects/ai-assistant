import { ChannelType, PermissionFlagsBits } from "discord.js";
export function discordMessageLocation(value) {
    try {
        const url = new URL(value);
        if (!/^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/i.test(url.hostname) || url.protocol !== "https:")
            return;
        const match = url.pathname.match(/^\/channels\/(\d+|@me)\/(\d+)\/(\d+)\/?$/);
        if (match)
            return { guild: match[1], channel: match[2], message: match[3] };
    }
    catch { /* Not a Discord message link. */ }
}
export function urlsInText(content) {
    return [...new Set((content.match(/https?:\/\/[^\s<>"\]]+/g) ?? []).map((url) => url.replace(/[),.!?;]+$/, "")))].slice(0, 20);
}
/** Capture the actual requester in a host callback, never a tool argument. */
export function artifactMessageResolver(client, requester, canIncludeAuthor = () => true) {
    return async (url) => {
        const message = await readArtifactMessage(client, requester, url, canIncludeAuthor);
        const location = discordMessageLocation(url);
        const sourceMessage = `https://discord.com/channels/${location.guild}/${location.channel}/${location.message}`;
        const candidates = [...message.attachments.values()].map((file) => ({
            url: file.url, name: file.name, contentType: file.contentType, size: file.size, sourceMessage,
        }));
        const links = urlsInText(message.content);
        for (const embed of message.embeds) {
            for (const link of [embed.url, embed.image?.url, embed.video?.url, embed.thumbnail?.url]) {
                if (link)
                    links.push(link);
            }
            links.push(...urlsInText([embed.description, ...embed.fields.map((field) => field.value)].filter(Boolean).join("\n")));
        }
        for (const link of links) {
            if (!candidates.some((candidate) => candidate.url === link))
                candidates.push({ url: link, sourceMessage });
        }
        return { candidates: candidates.slice(0, 20) };
    };
}
export async function readArtifactMessage(client, requester, url, canIncludeAuthor = () => true) {
    const location = discordMessageLocation(url);
    if (!location)
        throw new Error("Invalid Discord message URL.");
    const channel = await client.channels.fetch(location.channel);
    if (!channel || !("messages" in channel))
        throw new Error("Discord channel is unavailable.");
    if (channel.isDMBased()) {
        if (location.guild !== "@me" || channel.type !== ChannelType.DM || channel.recipientId !== requester) {
            throw new Error("You cannot read this Discord conversation.");
        }
    }
    else {
        const guildChannel = channel;
        if (guildChannel.guildId !== location.guild)
            throw new Error("Discord message server does not match its channel.");
        const member = await guildChannel.guild.members.fetch(requester);
        const permissions = guildChannel.permissionsFor(member);
        const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
        if (!permissions?.has(required) || !client.user || !guildChannel.permissionsFor(client.user.id)?.has(required)) {
            throw new Error("You or the bot lack permission to read this Discord channel.");
        }
        if (channel.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads)) {
            if (!await channel.members.fetch(requester).catch(() => null)) {
                throw new Error("You are not a member of this private thread.");
            }
        }
    }
    const message = await channel.messages.fetch(location.message);
    if (!canIncludeAuthor(message.author.id))
        throw new Error("This message is excluded by the bot's context policy.");
    return message;
}
