import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type Client, type MessageCreateOptions,
} from "discord.js";
import { createAccessPolicy } from "../../common/accessPolicy.js";
import { discordSubject } from "../../common/discordAccess.js";
import { githubContributionService } from "../../common/githubContributions.js";
import { GitHubMaintainer, type ActionContext, type ContributionCard, type MaintainerAction } from "../../common/githubMaintainer.js";
import { GitHubActionError, GitHubUserAuth, githubActionDirectory, githubActionsEnabled } from "../../common/githubUserAuth.js";
import { interactionSessionKey } from "../../common/discordSessionKey.js";

export const githubCommand = new SlashCommandBuilder().setName("github").setDescription("Link your GitHub account and manage PRs in this conversation")
  .addSubcommand(sub => sub.setName("link").setDescription("Privately link your own GitHub identity"))
  .addSubcommand(sub => sub.setName("unlink").setDescription("Remove your GitHub authorization from this bot"))
  .addSubcommand(sub => sub.setName("status").setDescription("Show your linked account and refresh this conversation's PR buttons"));

function button(action: string, id: string, label: string, disabled = false) {
  return new ButtonBuilder().setCustomId(`gh:${action}:${id}`).setLabel(label).setStyle(action === "merge" || action === "release" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled);
}

export function githubCardMessage(card: ContributionCard, reviewed: boolean) {
  const release = card.release;
  const status = card.merged ? `Merged: \`${card.merged.slice(0, 12)}\`` : `Revision: \`${card.head.slice(0, 12)}\` · Base: \`${card.base?.slice(0, 12) ?? "awaiting review"}\`\nServer review: ${reviewed ? "clean" : "pending, stale, or has findings"}`;
  const releaseStatus = release ? `\nRelease: **${release.tag}** from \`${release.sha.slice(0, 12)}\`\nChanges since ${release.previous} are attached. This publishes the image and updates latest; deployment is a separate PR.${release.url ? `\nPublication: ${release.state ?? "requested"} — ${release.url}` : ""}` : "";
  return {
    content: `**${card.repository} #${card.pull}**\nhttps://github.com/${card.repository}/pull/${card.pull}\n${status}${releaseStatus}\n\nApprove uses the clicking person's linked GitHub account. GitHub decides whether that review counts. Merge and release require maintainer permission.`,
    allowedMentions: { parse: [] },
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("approve", card.id, "Approve PR", Boolean(card.merged) || !reviewed),
      button("merge", card.id, "Merge PR", Boolean(card.merged) || !reviewed),
      button("release", card.id, release ? `Release ${release.tag}` : "Cut release", !release || card.attempts.some(attempt => attempt.action === "release")),
      button("refresh", card.id, "Refresh"),
      button("link", card.id, "Link GitHub"),
    )],
    ...(release ? { files: [new AttachmentBuilder(Buffer.from(`# ${release.tag}\n\nCommit: ${release.sha}\nChanges since ${release.previous}:\n\n${release.notes}\n`), { name: "release-notes.md" })] } : {}),
  } satisfies MessageCreateOptions;
}

class DiscordGitHub {
  readonly auth: GitHubUserAuth;
  readonly actions: GitHubMaintainer;
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private readonly shutdown = new AbortController();
  constructor() {
    const directory = githubActionDirectory();
    this.auth = new GitHubUserAuth(process.env.GITHUB_USER_APP_CLIENT_ID?.trim() || "", directory);
    this.actions = new GitHubMaintainer(this.auth, (session, guild) => githubContributionService().actionTargets(session, guild), directory);
  }
  start(client: Client) {
    if (this.timer) return;
    const poll = () => {
      if (this.polling || this.shutdown.signal.aborted) return;
      this.polling = this.poll(client).finally(() => { this.polling = undefined; });
    };
    this.timer = setInterval(poll, 30_000); this.timer.unref(); poll();
  }
  async stop() { clearInterval(this.timer); this.shutdown.abort(); await this.polling; }
  private async poll(client: Client) {
    for (const card of this.actions.pendingReleases().slice(0, 10)) {
      try {
        const attempt = card.attempts.find(attempt => attempt.action === "release")!;
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(60_000)]);
        const authorize = async () => {
          if (!githubActionsEnabled()) throw new GitHubActionError("GitHub actions are disabled.");
          const subject = await discordSubject(client, attempt.discordUser, card.guild, signal);
          if (!createAccessPolicy().can(subject, "github.release")) throw new GitHubActionError("Release monitoring permission was revoked.");
          signal.throwIfAborted();
        };
        const context: ActionContext = { userId: attempt.discordUser, guild: card.guild, channel: card.channel, signal, authorize };
        await this.actions.refresh(card.id, context);
        const channel = await client.channels.fetch(card.channel);
        if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== card.guild || !card.message) continue;
        const member = channel.guild.members.cache.get(attempt.discordUser);
        if (!member || !channel.permissionsFor(member)?.has(["ViewChannel", "ReadMessageHistory"])) continue;
        const message = await channel.messages.fetch(card.message);
        if (message.author.id === client.user?.id) await message.edit({ ...githubCardMessage(card, this.actions.reviewReady(card)), attachments: [] });
      } catch { /* Durable receipts are retried on the next poll, without repeating the mutation. */ }
    }
  }
  private context(interaction: ButtonInteraction | ChatInputCommandInteraction): ActionContext {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(100_000)]);
    const authorize = async (action: MaintainerAction | "read") => {
      if (!githubActionsEnabled() || !interaction.guildId) throw new GitHubActionError("GitHub actions are available only in server conversations.");
      const subject = await discordSubject(interaction.client, interaction.user.id, interaction.guildId, signal);
      const access = createAccessPolicy();
      const capability = action === "merge" ? "github.merge" : action === "release" ? "github.release" : "github.contribute";
      if (!access.can(subject, capability)) throw new GitHubActionError(`You do not have permission to ${action === "read" ? "use GitHub actions" : action} through this bot.`);
      signal.throwIfAborted();
    };
    return { userId: interaction.user.id, guild: interaction.guildId ?? "", channel: interaction.channelId, signal, authorize };
  }
  private async link(interaction: ButtonInteraction | ChatInputCommandInteraction, context: ActionContext) {
    const pending = await this.auth.begin(context.userId, context.signal);
    await interaction.editReply({ content: `Link **your own** GitHub account at https://github.com/login/device using code **${pending.code}**.\nOnly authorize a code you requested yourself. After authorizing, click Finish linking. Linking does not approve, merge, or release anything.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button("finish", pending.id, "Finish linking"))], allowedMentions: { parse: [] } });
  }
  async handle(interaction: ButtonInteraction | ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const context = this.context(interaction);
      // Unlinking remains available after contribution permissions have been revoked.
      if (interaction.isChatInputCommand() && interaction.options.getSubcommand() === "unlink") {
        this.auth.unlink(interaction.user.id);
        await interaction.editReply("Your GitHub account and pending link were removed from this bot. You can also revoke the App in GitHub Settings → Applications."); return;
      }
      await context.authorize("read");
      if (interaction.isChatInputCommand()) {
        if (interaction.options.getSubcommand() === "link") { await this.link(interaction, context); return; }
        const linked = this.auth.linked(context.userId);
        await this.present(interaction.client, interactionSessionKey(interaction), context.guild, context.channel, context);
        await interaction.editReply(linked ? `Linked as @${linked.login}. PR cards for this conversation have been refreshed.` : "You have not linked GitHub. Use /github link or the Link GitHub button. PR cards are available for this conversation's bot contributions.");
        return;
      }
      const [, action, id] = interaction.customId.split(":");
      if (action === "finish") {
        const user = await this.auth.finish(context.userId, id, context.signal);
        await interaction.editReply(user ? `Linked as **@${user.login}**. Your approvals will use this account. Click the PR action again when you're ready.` : "GitHub is still waiting for authorization. Enter your code, then click Finish linking again.");
        return;
      }
      const card = this.actions.get(id, context);
      if (card.message !== interaction.message.id || interaction.message.author.id !== interaction.client.user.id) throw new GitHubActionError("This button does not belong to the current action card.");
      if (action === "link" || !this.auth.linked(context.userId)) { await this.link(interaction, context); return; }
      if (action === "refresh") {
        const result = await this.actions.refresh(id, context);
        await interaction.message.edit({ ...githubCardMessage(result.card, this.actions.reviewReady(result.card)), attachments: [] });
        await interaction.editReply(`Refreshed using @${result.actor}. Each action will recheck GitHub before proceeding.`); return;
      }
      if (action !== "approve" && action !== "merge" && action !== "release") throw new GitHubActionError("Unknown GitHub action.");
      const result = await this.actions.act(id, action, context);
      await interaction.message.edit({ ...githubCardMessage(card, this.actions.reviewReady(card)), attachments: [] });
      await interaction.editReply(result);
    } catch (error) {
      // Never log OAuth payloads, tokens, or transport errors carrying credential-bearing request data.
      await interaction.editReply(error instanceof GitHubActionError ? error.message : "GitHub action could not complete. Refresh to check its state before trying again.").catch(() => {});
    }
  }
  async present(client: Client, session: string, guild: string, channelId: string, context?: ActionContext) {
    const cards = this.actions.forConversation(session, guild, channelId);
    if (!cards.length) return;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.isSendable() || channel.isDMBased() || channel.guildId !== guild) return;
    for (const card of cards) {
      if (context && this.auth.linked(context.userId)) await this.actions.refresh(card.id, context);
      const message = githubCardMessage(card, this.actions.reviewReady(card));
      if (card.message) {
        const existing = await channel.messages.fetch(card.message).catch(() => undefined);
        if (existing && existing.author.id === client.user?.id) { await existing.edit({ ...message, attachments: [] }); continue; }
      }
      const sent = await channel.send(message);
      this.actions.setMessage(card, sent.id);
    }
  }
}

let configured: DiscordGitHub | undefined;
export function discordGitHub(): DiscordGitHub | undefined {
  if (!githubActionsEnabled()) return undefined;
  return configured ??= new DiscordGitHub();
}

/** Called by Discord delivery, never by model output parsing or an MCP mutation. */
export async function presentGitHubCards(client: Client, session: string, guild: string, channel: string): Promise<void> {
  try { await discordGitHub()?.present(client, session, guild, channel); }
  catch { console.warn("[github-actions] Could not refresh contribution cards; use /github status."); }
}
