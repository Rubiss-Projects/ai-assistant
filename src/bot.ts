import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChatInputCommandInteraction,
} from "discord.js";
import { SessionManager } from "./sessionManager.js";
import { handleAsk } from "./handlers/slash/ask.js";
import { handleChat } from "./handlers/slash/chat.js";
import { handleReset } from "./handlers/slash/reset.js";
import { handleServers } from "./handlers/slash/servers.js";
import { handleLeave } from "./handlers/slash/leave.js";
import { handleModel } from "./handlers/slash/model.js";
import { handleReasoning } from "./handlers/slash/reasoning.js";
import { handleProvider } from "./handlers/slash/provider.js";
import { handleStatus } from "./handlers/slash/status.js";
import { handleHistory } from "./handlers/slash/history.js";
import { handleAgent } from "./handlers/slash/agent.js";
import { handleMode } from "./handlers/slash/mode.js";
import { handleCompact } from "./handlers/slash/compact.js";
import { handleFleet } from "./handlers/slash/fleet.js";
import { handlePlan } from "./handlers/slash/plan.js";
import { handleWorkspace } from "./handlers/slash/workspace.js";
import { handleMcp } from "./handlers/slash/mcp.js";
import { ChatParticipation, participationMode, parseParticipationDecision } from "./common/chatParticipation.js";
import { participationEvaluatorConfig } from "./common/participationEvaluator.js";
import { participationEmojis, reactWithParticipationEmoji, assistantIdentity, explicitlyMentionsBot, participationContext, participationReplyContext, participationAttachments } from "./common/discordParticipation.js";
import type { Message } from "discord.js";
import { handleMention } from "./handlers/mention.js";

import os from "node:os";
import path from "node:path";
import { createAccessPolicy, canInvokeSlashCommand, slashCommandRequiresAdmin } from "./common/accessPolicy.js";
import { sharedSecurityEnabled } from "./common/providerSecurity.js";
import { Scheduler } from "./scheduling/engine.js";
import { ScheduleStore } from "./scheduling/store.js";
import { discordSubject, contextAuthorPolicy } from "./common/discordAccess.js";
import { DiscordScheduleAdapter } from "./scheduling/discordAdapter.js";
import { handleSchedule } from "./handlers/slash/schedule.js";
export { createAccessPolicy, canInvokeSlashCommand, slashCommandRequiresAdmin } from "./common/accessPolicy.js";
export type { SlashCommandRequest } from "./common/accessPolicy.js";

export function createBot(sessions: SessionManager): Client & { stopScheduler(): Promise<void> } {
  // Computed here so dotenv.config() has already run in index.ts.
  const access = createAccessPolicy();
  const sharedMode = sharedSecurityEnabled();
  const chatParticipationMode = participationMode(sharedMode);
  if (chatParticipationMode === "smart") participationEvaluatorConfig();

  // Channel ID(s) where the bot responds to every message without needing a mention
  const freeChannels = new Set(
    (process.env.DISCORD_FREE_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // Required for DM support
  });

  const participation = new ChatParticipation<Message>({
    id: message => message.id,
    identity: message => assistantIdentity(message, client.user!),
    emojis: participationEmojis,
    context: messages => participationContext(messages, client.user!.id,
      contextAuthorPolicy(access, client, messages[0].guildId)),
    classify: async (prompt, target) => {
      const started = Date.now();
      const result = await sessions.evaluateParticipation(target.channelId, prompt);
      // Log routing only, never conversation text or raw model output.
      const state = JSON.parse(prompt);
      const decision = parseParticipationDecision(result, state.candidateIds, state.availableEmojis);
      console.info(`[participation] thread=${target.channelId} action=${decision.action} elapsedMs=${Date.now() - started}`);
      return result;
    },
    reply: async (target, context, requests) => {
      const subject = await discordSubject(client, target.author.id, target.guildId).catch(() => undefined);
      if (!subject || !access.canMessage(target.author.id, subject)) return;
      await handleMention(target, client, sessions, target.channelId,
        contextAuthorPolicy(access, client, target.guildId),
        { context: participationReplyContext(context, requests.map(message => message.id)), requests, attachments: participationAttachments(context) });
    },
    react: async (target, emoji) => {
      await reactWithParticipationEmoji(target, emoji);
    },
    onError: () => console.warn("[participation] Evaluation failed; staying silent. Check evaluator access, model and timeout settings."),
  });

  const enabled = process.env.SCHEDULES_ENABLED?.trim() || "false";
  if (!["true", "false"].includes(enabled)) throw new Error("SCHEDULES_ENABLED must be true or false.");
  const scheduler = enabled === "true" ? new Scheduler(
    new ScheduleStore(path.join(os.homedir(), ".config", "ai-assistant", "schedules.sqlite")),
    access, new DiscordScheduleAdapter(client, access, sessions),
  ) : undefined;

  client.once(Events.ClientReady, (c) => {
    try { scheduler?.start(); }
    catch (error) {
      console.error("[scheduler] Startup failed:", error);
      process.exitCode = 1;
      client.destroy();
      void sessions.shutdown();
      return;
    }
    console.log(`✅ Discord bot ready as ${c.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction as ChatInputCommandInteraction;
    const roles = cmd.member?.roles;
    const subject = { userId: cmd.user.id, guildId: cmd.guildId,
      roleIds: Array.isArray(roles) ? roles : roles ? [...roles.cache.keys()] : [] };
    // Block private entry points before dispatch. Private one-shot requests need an
    // explicit admin or ask.use grant; legacy open-admin access is insufficient.
    const restrictedAsk = cmd.commandName === "ask" && !access.can(subject, "ask.use");
    if (sharedMode && (!cmd.guildId || restrictedAsk)) {
      await cmd.reply({
        content: !cmd.guildId
          ? "⛔ DMs are disabled in shared mode. Use /chat or mention me in a server channel."
          : "⛔ /ask requires explicit permission in shared mode. Use /chat or mention me in a server channel.",
        ephemeral: true,
      });
      return;
    }
    const subcommand = cmd.options.getSubcommand(false);
    const hasWorkspace = (cmd.commandName === "ask" || cmd.commandName === "chat")
      && Boolean(cmd.options.getString("workspace", false));
    const request = { commandName: cmd.commandName, subcommand, hasWorkspace };

    if (cmd.commandName === "schedule") {
      await handleSchedule(cmd, scheduler, subject);
      return;
    }
    if (!canInvokeSlashCommand(access, interaction.user.id, request, subject)) {
      const content = slashCommandRequiresAdmin(request)
        ? "⛔ This action is restricted to bot administrators."
        : "⛔ You are not authorized to use this bot.";
      await interaction.reply({ content, ephemeral: true });
      return;
    }

    switch (cmd.commandName) {
      case "ask":
        await handleAsk(cmd, sessions, contextAuthorPolicy(access, client, cmd.guildId));
        break;
      case "chat":
        await handleChat(cmd, sessions, contextAuthorPolicy(access, client, cmd.guildId),
          chatParticipationMode === "always" ? undefined : (key, run) => participation.runExplicit(key, run),
          chatParticipationMode === "always" ? undefined : async source => {
            if (!source.channel.isThread() || source.channel.ownerId !== client.user?.id) return [];
            const context = await participationContext([source], client.user.id,
              contextAuthorPolicy(access, client, cmd.guildId), {
                authorId: cmd.user.id, authorName: cmd.user.username,
                content: cmd.options.getString("message", true),
              });
            return context;
          });
        break;
      case "reset":
        await handleReset(cmd, sessions);
        break;
      case "servers":
        await handleServers(cmd, client);
        break;
      case "leave":
        await handleLeave(cmd, client);
        break;
      case "model":
        await handleModel(cmd, sessions);
        break;
      case "reasoning":
        await handleReasoning(cmd, sessions);
        break;
      case "provider":
        await handleProvider(cmd, sessions);
        break;
      case "status":
        await handleStatus(cmd, sessions);
        break;
      case "history":
        await handleHistory(cmd, sessions);
        break;
      case "agent":
        await handleAgent(cmd, sessions);
        break;
      case "mode":
        await handleMode(cmd, sessions);
        break;
      case "compact":
        await handleCompact(cmd, sessions);
        break;
      case "fleet":
        await handleFleet(cmd, sessions);
        break;
      case "plan":
        await handlePlan(cmd, sessions);
        break;
      case "workspace":
        await handleWorkspace(cmd, sessions);
        break;
      case "mcp":
        await handleMcp(cmd, sessions);
        break;
      default:
        console.warn(`Unknown command: ${cmd.commandName}`);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (sharedMode && !message.guildId) return;
    if (message.author.bot) return;
    if (!client.user) return;
    const ownedThread = message.channel.isThread() && message.channel.ownerId === client.user.id;
    const isMentioned = message.mentions.has(client.user.id);
    const isFreeChannel = freeChannels.has(message.channelId);
    if (!ownedThread && !isMentioned && !isFreeChannel) return;
    const subject = await discordSubject(client, message.author.id, message.guildId).catch(() => undefined);
    if (!subject || !access.canMessage(message.author.id, subject)) return;

    // Shared conversations decide before enrichment, typing indicators or agent execution.
    if (ownedThread && chatParticipationMode !== "always") {
      const explicit = explicitlyMentionsBot(message, client.user.id);
      if (chatParticipationMode === "mentions-only" && !explicit) return;
      participation.enqueue(message.channelId, message, explicit);
      return;
    }
    if (ownedThread) {
      await handleMention(message, client, sessions, message.channelId, contextAuthorPolicy(access, client, message.guildId));
      return;
    }

    await handleMention(message, client, sessions, undefined, contextAuthorPolicy(access, client, message.guildId));
  });

  return Object.assign(client, { stopScheduler: async () => { await Promise.all([scheduler?.stop(), participation.stop()]); } });
}
