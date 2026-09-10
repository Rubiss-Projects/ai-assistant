import { Client, GatewayIntentBits, Partials, Events, } from "discord.js";
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
import { handleMention } from "./handlers/mention.js";
import os from "node:os";
import path from "node:path";
import { createAccessPolicy, canInvokeSlashCommand, slashCommandRequiresAdmin } from "./common/accessPolicy.js";
import { Scheduler } from "./scheduling/engine.js";
import { ScheduleStore } from "./scheduling/store.js";
import { discordSubject, contextAuthorPolicy } from "./common/discordAccess.js";
import { DiscordScheduleAdapter } from "./scheduling/discordAdapter.js";
import { handleSchedule } from "./handlers/slash/schedule.js";
export { createAccessPolicy, canInvokeSlashCommand, slashCommandRequiresAdmin } from "./common/accessPolicy.js";
export function createBot(sessions) {
    // Computed here so dotenv.config() has already run in index.ts.
    const access = createAccessPolicy();
    // Channel ID(s) where the bot responds to every message without needing a mention
    const freeChannels = new Set((process.env.DISCORD_FREE_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel], // Required for DM support
    });
    const enabled = process.env.SCHEDULES_ENABLED?.trim() || "false";
    if (!["true", "false"].includes(enabled))
        throw new Error("SCHEDULES_ENABLED must be true or false.");
    const scheduler = enabled === "true" ? new Scheduler(new ScheduleStore(path.join(os.homedir(), ".config", "ai-assistant", "schedules.sqlite")), access, new DiscordScheduleAdapter(client, access, sessions)) : undefined;
    client.once(Events.ClientReady, (c) => {
        try {
            scheduler?.start();
        }
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
        if (!interaction.isChatInputCommand())
            return;
        const cmd = interaction;
        const subcommand = cmd.options.getSubcommand(false);
        const hasWorkspace = (cmd.commandName === "ask" || cmd.commandName === "chat")
            && Boolean(cmd.options.getString("workspace", false));
        const request = { commandName: cmd.commandName, subcommand, hasWorkspace };
        const roles = cmd.member?.roles;
        const subject = { userId: cmd.user.id, guildId: cmd.guildId,
            roleIds: Array.isArray(roles) ? roles : roles ? [...roles.cache.keys()] : [] };
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
                await handleChat(cmd, sessions, contextAuthorPolicy(access, client, cmd.guildId));
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
        if (message.author.bot)
            return;
        if (!client.user)
            return;
        const ownedThread = message.channel.isThread() && message.channel.ownerId === client.user.id;
        const isMentioned = message.mentions.has(client.user.id);
        const isFreeChannel = freeChannels.has(message.channelId);
        if (!ownedThread && !isMentioned && !isFreeChannel)
            return;
        const subject = await discordSubject(client, message.author.id, message.guildId).catch(() => undefined);
        if (!subject || !access.canMessage(message.author.id, subject))
            return;
        // Bot-owned threads: respond to every message, session keyed by thread ID
        if (ownedThread) {
            await handleMention(message, client, sessions, message.channelId, contextAuthorPolicy(access, client, message.guildId));
            return;
        }
        await handleMention(message, client, sessions, undefined, contextAuthorPolicy(access, client, message.guildId));
    });
    return Object.assign(client, { stopScheduler: async () => { await scheduler?.stop(); } });
}
