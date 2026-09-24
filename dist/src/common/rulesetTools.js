import { randomUUID } from "node:crypto";
import { canManageUserInstructions, generatedRulesetName, UserInstructionStore, userInstructionFeaturesEnabled, validateInstructions, validateRulesetName, } from "./userInstructionStore.js";
import { previewUserInstructions } from "../utils/userInstructions.js";
import { RULESET_TOOLS } from "./rulesetToolDefinitions.js";
export { RULESET_TOOLS } from "./rulesetToolDefinitions.js";
export function createRulesetToolRun() {
    return { id: randomUUID() };
}
export class RulesetTools {
    run;
    context;
    store;
    id;
    controller = new AbortController();
    queue = Promise.resolve();
    calls = 0;
    constructor(run, context, store = new UserInstructionStore()) {
        this.run = run;
        this.context = context;
        this.store = store;
        this.id = run.id;
        run.cleanup = () => this.close();
    }
    async cancel() {
        this.controller.abort();
        await this.queue.catch(() => { });
    }
    async close() {
        await this.cancel();
    }
    call(name, args) {
        const operation = this.queue.catch(() => { }).then(async () => {
            this.controller.signal.throwIfAborted();
            if (args.run_id !== this.id)
                throw new Error("This ruleset run has expired or belongs to another response.");
            if (++this.calls > 40)
                throw new Error("Ruleset tool call limit reached for this response.");
            const schema = RULESET_TOOLS.find((tool) => tool.name === name)?.inputSchema;
            if (!schema || Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)))
                throw new Error("Invalid ruleset tool arguments.");
            for (const key of schema.required)
                if (typeof args[key] !== "string" || !args[key].trim())
                    throw new Error(`Missing ${key}.`);
            for (const value of Object.values(args))
                if (typeof value !== "string" || value.length > 8192)
                    throw new Error("Tool arguments must be short strings.");
            if (name === "list_user_rulesets")
                return this.list(args);
            if (name === "get_user_ruleset")
                return this.get(args);
            if (name === "set_user_ruleset")
                return this.set(args);
            if (name === "append_user_ruleset")
                return this.append(args);
            if (name === "delete_user_ruleset")
                return this.delete(args);
            if (name === "clear_user_rulesets")
                return this.clear(args);
            if (name === "enable_user_ruleset")
                return this.enabled(args, true);
            if (name === "disable_user_ruleset")
                return this.enabled(args, false);
            if (name === "preview_user_rulesets")
                return this.preview(args);
            throw new Error("Unknown ruleset tool.");
        });
        this.queue = operation;
        return operation;
    }
    canManage(targetUserId) {
        return Boolean(this.context.access && this.context.requester
            && canManageUserInstructions(this.context.requester, targetUserId, this.context.access.can(this.context.requester, "ruleset.manage", { guildId: this.context.guildId ?? undefined })));
    }
    requireManage(targetUserId) {
        if (!userInstructionFeaturesEnabled() || !this.context.requester || !this.context.access) {
            throw new Error("Ruleset management is unavailable for this run.");
        }
        if (!this.canManage(targetUserId))
            throw new Error("You do not have permission to manage user rulesets for that Discord user.");
        return this.context.requester;
    }
    target(args) {
        const raw = String(args.user ?? "").trim();
        const match = raw.match(/^<@!?(\d+)>$/) ?? raw.match(/^(\d+)$/);
        if (!match)
            throw new Error("Provide a Discord user ID or mention.");
        return match[1];
    }
    list(args) {
        const target = this.target(args);
        this.requireManage(target);
        return { rulesets: this.store.listForUser(this.context.guildId ?? null, target, args.include_disabled === "true").map(toolRuleset) };
    }
    get(args) {
        const target = this.target(args);
        this.requireManage(target);
        const ruleset = this.store.get(this.context.guildId ?? null, target, String(args.name));
        if (!ruleset)
            throw new Error("Ruleset not found.");
        return { ruleset: toolRuleset(ruleset) };
    }
    set(args) {
        const target = this.target(args);
        const requester = this.requireManage(target);
        const instructions = validateInstructions(String(args.instructions));
        const name = args.name ? validateRulesetName(String(args.name)) : this.store.availableName(this.context.guildId, target, generatedRulesetName(instructions));
        const priority = args.priority == null || args.priority === "" ? undefined : Number(args.priority);
        if (priority !== undefined && !Number.isSafeInteger(priority))
            throw new Error("Priority must be an integer.");
        const ruleset = this.store.set({
            guildId: this.context.guildId ?? null,
            targetUserId: target,
            name,
            instructions,
            priority,
            createdBy: requester.userId,
            updatedBy: requester.userId,
        });
        console.info(`[ruleset] set guild=${this.context.guildId ?? "DM"} target=${ruleset.targetUserId} by=${requester.userId} name=${ruleset.name}`);
        return { status: "updated", ruleset: toolRuleset(ruleset) };
    }
    append(args) {
        const target = this.target(args);
        const requester = this.requireManage(target);
        const ruleset = this.store.append(this.context.guildId ?? null, target, String(args.name), String(args.instructions), requester.userId);
        console.info(`[ruleset] append guild=${this.context.guildId ?? "DM"} target=${ruleset.targetUserId} by=${requester.userId} name=${ruleset.name}`);
        return { status: "updated", ruleset: toolRuleset(ruleset) };
    }
    delete(args) {
        const target = this.target(args);
        const requester = this.requireManage(target);
        const name = validateRulesetName(String(args.name));
        const deleted = this.store.delete(this.context.guildId ?? null, target, name);
        console.info(`[ruleset] delete guild=${this.context.guildId ?? "DM"} target=${target} by=${requester.userId} name=${name}`);
        return { status: deleted ? "deleted" : "not_found", name };
    }
    clear(args) {
        const target = this.target(args);
        const requester = this.requireManage(target);
        const deleted = this.store.clear(this.context.guildId ?? null, target);
        console.info(`[ruleset] clear guild=${this.context.guildId ?? "DM"} target=${target} by=${requester.userId} count=${deleted}`);
        return { status: "cleared", deleted };
    }
    enabled(args, enabled) {
        const target = this.target(args);
        const requester = this.requireManage(target);
        const ruleset = this.store.setEnabled(this.context.guildId ?? null, target, String(args.name), enabled, requester.userId);
        console.info(`[ruleset] ${enabled ? "enable" : "disable"} guild=${this.context.guildId ?? "DM"} target=${ruleset.targetUserId} by=${requester.userId} name=${ruleset.name}`);
        return { status: enabled ? "enabled" : "disabled", ruleset: toolRuleset(ruleset) };
    }
    preview(args) {
        const userId = this.target(args);
        this.requireManage(userId);
        return {
            preview: previewUserInstructions({ guildId: this.context.guildId ?? null, userId }, args.include_disabled === "true", this.store),
        };
    }
}
function toolRuleset(ruleset) {
    return {
        id: ruleset.id,
        guild_id: ruleset.guildId,
        target_user_id: ruleset.targetUserId,
        name: ruleset.name,
        enabled: ruleset.enabled,
        priority: ruleset.priority,
        scope: ruleset.scope,
        instructions: ruleset.instructions,
        updated_at: ruleset.updatedAt,
    };
}
