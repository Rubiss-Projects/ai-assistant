import { ChatInputCommandInteraction } from "discord.js";
import { chunkForDiscord } from "../../sessionManager.js";
import { discordTextOptions } from "../../common/discordResponse.js";
import {
  canManageUserInstructions,
  generatedRulesetName,
  UserInstructionStore,
  validateInstructions,
  validateRulesetName,
} from "../../common/userInstructionStore.js";
import { previewUserInstructions } from "../../utils/userInstructions.js";
import type { AccessPolicy, AccessSubject } from "../../common/accessPolicy.js";

function targetUser(interaction: ChatInputCommandInteraction): { id: string; label: string } {
  const user = interaction.options.getUser("user", true);
  return { id: user.id, label: user.toString() };
}

async function replyLong(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const chunks = chunkForDiscord(content);
  if (interaction.deferred) await interaction.editReply(discordTextOptions(chunks[0]));
  else await interaction.reply({ ephemeral: true, ...discordTextOptions(chunks[0]) });
  for (const chunk of chunks.slice(1)) await interaction.followUp({ ephemeral: true, ...discordTextOptions(chunk) });
}

export async function handleRuleset(
  interaction: ChatInputCommandInteraction,
  subject: AccessSubject,
  access: AccessPolicy,
): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  const target = targetUser(interaction);
  const guildId = interaction.guildId ?? subject.guildId ?? null;
  try {
    await interaction.deferReply({ ephemeral: true });
    const isAdmin = access.can(subject, "ruleset.manage", { guildId: guildId ?? undefined });
    if (!canManageUserInstructions(subject, target.id, isAdmin)) {
      await interaction.editReply("You do not have permission to manage user rulesets for that Discord user.");
      return;
    }

    const store = new UserInstructionStore();
    if (sub === "list" || sub === "get") {
      const name = interaction.options.getString("name", false);
      const includeDisabled = interaction.options.getBoolean("include_disabled", false) ?? false;
      const rulesets = name
        ? [store.get(guildId, target.id, name)].filter((item) => item !== undefined)
        : store.listForUser(guildId, target.id, includeDisabled);
      if (!rulesets.length) {
        await interaction.editReply(`No rulesets found for ${target.label}.`);
        return;
      }
      const lines = rulesets.map((ruleset) =>
        `- \`${ruleset.name}\` ${ruleset.enabled ? "enabled" : "disabled"} priority ${ruleset.priority} updated ${ruleset.updatedAt}\n${ruleset.instructions}`);
      await replyLong(interaction, `${target.label}\n${lines.join("\n\n")}`);
      return;
    }

    if (sub === "set") {
      const instructions = validateInstructions(interaction.options.getString("instructions", true));
      const requestedName = interaction.options.getString("name", false);
      const name = requestedName ? validateRulesetName(requestedName) : generatedRulesetName(instructions);
      const priority = interaction.options.getInteger("priority", false) ?? 100;
      const ruleset = store.set({ guildId, targetUserId: target.id, name, instructions, priority, createdBy: interaction.user.id, updatedBy: interaction.user.id });
      await interaction.editReply(`Updated ruleset \`${ruleset.name}\` for ${target.label}. It will apply on the next message.`);
      return;
    }

    if (sub === "append") {
      const name = interaction.options.getString("name", true);
      const instructions = interaction.options.getString("instructions", true);
      const ruleset = store.append(guildId, target.id, name, instructions, interaction.user.id);
      await interaction.editReply(`Updated ruleset \`${ruleset.name}\` for ${target.label}.`);
      return;
    }

    if (sub === "delete") {
      const name = interaction.options.getString("name", true);
      const deleted = store.delete(guildId, target.id, name);
      await interaction.editReply(deleted ? `Deleted ruleset \`${name}\` for ${target.label}.` : `No ruleset \`${name}\` found for ${target.label}.`);
      return;
    }

    if (sub === "clear") {
      const deleted = store.clear(guildId, target.id);
      await interaction.editReply(`Cleared ${deleted} ruleset${deleted === 1 ? "" : "s"} for ${target.label}.`);
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const name = interaction.options.getString("name", true);
      const ruleset = store.setEnabled(guildId, target.id, name, sub === "enable", interaction.user.id);
      await interaction.editReply(`${sub === "enable" ? "Enabled" : "Disabled"} ruleset \`${ruleset.name}\` for ${target.label}.`);
      return;
    }

    if (sub === "preview") {
      const includeDisabled = interaction.options.getBoolean("include_disabled", false) ?? false;
      await replyLong(interaction, previewUserInstructions({ guildId, userId: target.id, userDisplayName: target.label }, includeDisabled, store));
    }
  } catch (error) {
    console.error(`[/ruleset ${sub}] Error:`, error);
    const message = error instanceof Error ? error.message : "Failed to manage rulesets.";
    if (interaction.deferred) await interaction.editReply(`❌ ${message}`).catch(() => {});
    else await interaction.reply({ content: `❌ ${message}`, ephemeral: true }).catch(() => {});
  }
}
