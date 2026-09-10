import { ChannelType, SlashCommandBuilder, type SlashCommandSubcommandBuilder } from "discord.js";
const fields = (sub: SlashCommandSubcommandBuilder, required: boolean) => sub
  .addChannelOption(opt => opt.setName("channel").setDescription("Destination text channel").addChannelTypes(ChannelType.GuildText).setRequired(required))
  .addStringOption(opt => opt.setName("content").setDescription("Exact message text, or the AI prompt to run").setMaxLength(6000).setRequired(required))
  .addStringOption(opt => opt.setName("cron").setDescription("Five-field cron, for example 0 9 * * 1-5").setMaxLength(100).setRequired(required))
  .addStringOption(opt => opt.setName("timezone").setDescription("IANA timezone, for example America/New_York or UTC").setMaxLength(100).setRequired(required));
const context = (sub: SlashCommandSubcommandBuilder) => sub.addIntegerOption(opt => opt.setName("context_messages")
  .setDescription("AI only: recent destination messages to include (default 0)").setMinValue(0).setMaxValue(100));
const id = (sub: SlashCommandSubcommandBuilder) => sub.addStringOption(opt => opt.setName("id").setDescription("Schedule ID").setRequired(true));
export const scheduleCommand = new SlashCommandBuilder().setName("schedule").setDescription("Schedule channel messages and AI tasks")
  .addSubcommand(sub => context(fields(sub.setName("create").setDescription("Create a recurring task")
    .addStringOption(opt => opt.setName("kind").setDescription("Fixed message or AI prompt").setRequired(true)
      .addChoices({ name: "Fixed message", value: "message" }, { name: "AI prompt", value: "ai" })), true))
    .addStringOption(opt => opt.setName("provider").setDescription("AI provider (defaults to bot provider)")
      .addChoices(...["copilot", "codex", "opencode"].map(value => ({ name: value, value }))))
    .addStringOption(opt => opt.setName("model").setDescription("Required for AI tasks: model ID to save").setMaxLength(200))
    .addStringOption(opt => opt.setName("reasoning").setDescription("AI reasoning effort (Copilot/Codex)")
      .addChoices(...["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(value => ({ name: value, value })))))
  .addSubcommand(sub => sub.setName("list").setDescription("List schedules you can manage in this server"))
  .addSubcommand(sub => id(sub.setName("inspect").setDescription("Show task settings, next occurrences, and run history")))
  .addSubcommand(sub => context(fields(id(sub.setName("edit").setDescription("Edit a task; changes invalidate pending output")), false)))
  .addSubcommand(sub => id(sub.setName("pause").setDescription("Pause a schedule and suppress pending output")))
  .addSubcommand(sub => id(sub.setName("resume").setDescription("Resume future occurrences of a paused schedule")))
  .addSubcommand(sub => id(sub.setName("delete").setDescription("Delete a schedule and its run history")))
  .addSubcommand(sub => id(sub.setName("run-now").setDescription("Run an enabled task now, subject to frequency limits")))
  .addSubcommand(sub => id(sub.setName("retry-delivery").setDescription("Retry a definitely rejected send without repeating AI work"))
    .addStringOption(opt => opt.setName("run_id").setDescription("Failed delivery run ID").setRequired(true)));
