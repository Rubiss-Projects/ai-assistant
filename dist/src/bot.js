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
function userIdSet(value) {
    return new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}
export function createAccessPolicy(env = process.env) {
    const allowedUsers = userIdSet(env.DISCORD_ALLOWED_USERS);
    const adminUsers = userIdSet(env.DISCORD_ADMIN_USERS);
    const canMessage = (userId) => allowedUsers.size === 0 || allowedUsers.has(userId);
    return {
        canMessage,
        canUseAdminCommands: (userId) => adminUsers.size > 0 ? adminUsers.has(userId) : canMessage(userId),
    };
}
const ADMIN_COMMANDS = new Set(["fleet", "leave", "mcp", "servers", "status", "workspace"]);
const PUBLIC_COMMANDS = new Set(["compact", "history", "reset"]);
const PUBLIC_SUBCOMMANDS = {
    agent: new Set(["current", "list"]),
    mode: new Set(["get"]),
    model: new Set(["current", "list"]),
    plan: new Set(["delete", "read", "update"]),
    provider: new Set(["current", "list"]),
    reasoning: new Set(["current", "list"]),
};
/** Unknown commands and subcommands are administrative by default. */
export function slashCommandRequiresAdmin(request) {
    const { commandName, subcommand, hasWorkspace = false } = request;
    if (ADMIN_COMMANDS.has(commandName))
        return true;
    if (PUBLIC_COMMANDS.has(commandName))
        return false;
    if (commandName === "ask" || commandName === "chat")
        return hasWorkspace;
    return !subcommand || !PUBLIC_SUBCOMMANDS[commandName]?.has(subcommand);
}
export function canInvokeSlashCommand(access, userId, request) {
    if (access.canUseAdminCommands(userId))
        return true;
    return !slashCommandRequiresAdmin(request) && access.canMessage(userId);
}
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
    client.once(Events.ClientReady, (c) => {
        console.log(`✅ Discord bot ready as ${c.user.tag}`);
    });
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand())
            return;
        const cmd = interaction;
        const subcommandCommands = new Set(["agent", "mode", "model", "provider", "reasoning"]);
        const subcommand = subcommandCommands.has(cmd.commandName)
            ? cmd.options.getSubcommand(false)
            : null;
        const hasWorkspace = (cmd.commandName === "ask" || cmd.commandName === "chat")
            && Boolean(cmd.options.getString("workspace", false));
        const request = { commandName: cmd.commandName, subcommand, hasWorkspace };
        if (!canInvokeSlashCommand(access, interaction.user.id, request)) {
            const content = slashCommandRequiresAdmin(request)
                ? "⛔ This action is restricted to bot administrators."
                : "⛔ You are not authorized to use this bot.";
            await interaction.reply({ content, ephemeral: true });
            return;
        }
        switch (cmd.commandName) {
            case "ask":
                await handleAsk(cmd, sessions);
                break;
            case "chat":
                await handleChat(cmd, sessions);
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
        if (!access.canMessage(message.author.id))
            return;
        // Bot-owned threads: respond to every message, session keyed by thread ID
        if (message.channel.isThread() && message.channel.ownerId === client.user.id) {
            await handleMention(message, client, sessions, message.channelId, access.canMessage);
            return;
        }
        const isMentioned = message.mentions.has(client.user.id);
        const isFreeChannel = freeChannels.has(message.channelId);
        if (!isMentioned && !isFreeChannel)
            return;
        await handleMention(message, client, sessions, undefined, access.canMessage);
    });
    return client;
}
