import type { Client } from "discord.js";
import type { AccessPolicy, AccessSubject } from "./accessPolicy.js";

export async function discordSubject(client: Client, userId: string, guildId?: string | null): Promise<AccessSubject> {
  if (!guildId) return { userId };
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch({ user: userId, force: true });
  return { userId, guildId, roleIds: [...member.roles.cache.keys()] };
}

/** Existing context filters are synchronous. Unknown role membership is excluded. */
export function contextAuthorPolicy(access: AccessPolicy, client: Client, guildId?: string | null): (userId: string) => boolean {
  return userId => access.canMessage(userId, {
    userId, guildId,
    roleIds: guildId ? [...(client.guilds.cache.get(guildId)?.members.cache.get(userId)?.roles.cache.keys() ?? [])] : [],
  });
}
