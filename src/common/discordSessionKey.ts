import type { ChatInputCommandInteraction } from "discord.js";

export function interactionSessionKey(interaction: ChatInputCommandInteraction): string {
  if (interaction.channel?.isThread()) return interaction.channelId;
  if (interaction.guildId) return `${interaction.user.id}:${interaction.channelId}`;
  return interaction.user.id;
}

export function interactionSessionLabel(interaction: ChatInputCommandInteraction): string {
  if (interaction.channel?.isThread()) return "this thread";
  if (interaction.guildId) return "your session in this channel";
  return "your DM session";
}
