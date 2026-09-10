import { chunkForDiscord } from "../../common/chunkForDiscord.js";
import { nextOccurrences, scheduleDescription } from "../../scheduling/cron.js";
import { PROVIDERS } from "../../providers/types.js";
export function describeTask(task) {
    const dates = nextOccurrences(task.cron, task.timezone).map(time => `<t:${Math.floor(time / 1000)}:F>`).join("\n");
    return `Schedule \`${task.id}\` — ${task.enabled ? "enabled" : "paused"}\nOwner: <@${task.ownerId}> · Destination: <#${task.channelId}>\n${scheduleDescription(task.cron, task.timezone)}\nCron: \`${task.cron}\`\nNext occurrences${task.enabled ? "" : " (if resumed)"}:\n${dates}\n${task.pauseReason ?? ""}\n${task.kind === "ai" ? `AI: ${task.provider} / ${task.model}; context: ${task.contextMessages} messages\n` : ""}${task.content}`;
}
export async function handleSchedule(cmd, scheduler, subject) {
    await cmd.deferReply({ ephemeral: true });
    const respond = async (text) => {
        const chunks = chunkForDiscord(text);
        await cmd.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
        for (const content of chunks.slice(1))
            await cmd.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
    };
    try {
        if (!scheduler)
            throw new Error("Scheduling is disabled. The operator must set SCHEDULES_ENABLED=true and grant scheduling rights.");
        scheduler.assertAvailable();
        if (!subject.guildId)
            throw new Error("Manage schedules from their Discord server.");
        const sub = cmd.options.getSubcommand(true);
        if (sub === "create") {
            const kind = cmd.options.getString("kind", true);
            const provider = cmd.options.getString("provider") ?? process.env.PROVIDER ?? "copilot";
            if (kind === "ai" && !PROVIDERS.includes(provider))
                throw new Error("Choose a supported provider.");
            const model = cmd.options.getString("model") ?? undefined;
            const reasoning = cmd.options.getString("reasoning") ?? (provider === "opencode" ? undefined : "low");
            if (kind === "ai" && !model)
                throw new Error("Specify a model for an AI schedule so its behavior is saved explicitly.");
            if (kind === "ai" && provider === "opencode" && reasoning)
                throw new Error("OpenCode does not support reasoning effort selection.");
            const task = await scheduler.create(subject, {
                guildId: subject.guildId, channelId: cmd.options.getChannel("channel", true).id,
                kind, content: cmd.options.getString("content", true), cron: cmd.options.getString("cron", true),
                timezone: cmd.options.getString("timezone", true), contextMessages: cmd.options.getInteger("context_messages") ?? 0,
                ...(kind === "ai" ? { provider: provider, model, reasoning } : {}),
            });
            await respond(describeTask(task));
            return;
        }
        if (sub === "list") {
            const tasks = scheduler.store.list(subject.guildId).filter(task => scheduler.canManage(subject, task));
            await respond(tasks.length ? tasks.map(task => `\`${task.id}\` · ${task.enabled ? "enabled" : "paused"} · ${task.kind} · <#${task.channelId}>`).join("\n") : "No schedules available to you.");
            return;
        }
        const id = cmd.options.getString("id", true);
        const task = scheduler.requireTask(subject, id);
        if (sub === "inspect") {
            const runs = scheduler.store.runs(id).slice(0, 10).map(run => `\`${run.id}\` · ${run.state} · <t:${Math.floor(run.startedAt / 1000)}:f>${run.error ? ` · ${run.error}` : ""}\n${run.messageIds.map(message => `https://discord.com/channels/${task.guildId}/${run.channelId}/${message}`).join("\n")}`);
            await respond(`${describeTask(task)}\n\nRecent runs:\n${runs.join("\n") || "None yet."}`);
        }
        else if (sub === "edit") {
            const patch = {};
            for (const key of ["content", "cron", "timezone"]) {
                const value = cmd.options.getString(key);
                if (value !== null)
                    patch[key] = value;
            }
            const channel = cmd.options.getChannel("channel");
            if (channel)
                patch.channelId = channel.id;
            const context = cmd.options.getInteger("context_messages");
            if (context !== null)
                patch.contextMessages = context;
            if (!Object.keys(patch).length)
                throw new Error("Provide at least one field to edit.");
            await respond(describeTask(await scheduler.edit(subject, id, patch)));
        }
        else if (sub === "pause") {
            scheduler.pause(subject, id);
            await respond("Schedule paused. Any pending result will not be posted.");
        }
        else if (sub === "resume") {
            await scheduler.resume(subject, id);
            await respond("Schedule resumed. Missed occurrences will be skipped.");
        }
        else if (sub === "delete") {
            scheduler.delete(subject, id);
            await respond("Schedule and its run history deleted.");
        }
        else if (sub === "run-now") {
            await respond(`Started run \`${scheduler.runNow(subject, id)}\`. Use /schedule inspect to check its result.`);
        }
        else if (sub === "retry-delivery") {
            scheduler.retryDelivery(subject, id, cmd.options.getString("run_id", true));
            await respond("Retrying the unsent result without running the AI again.");
        }
        else
            throw new Error("Unknown schedule action.");
    }
    catch (error) {
        console.error("[/schedule]", error);
        await respond(error instanceof Error ? error.message : "Schedule operation failed.");
    }
}
