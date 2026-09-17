import { randomUUID } from "node:crypto";
import type { AccessPolicy, AccessSubject } from "./accessPolicy.js";
import {
  canManageUserInstructions,
  generatedRulesetName,
  normalizeRulesetName,
  UserInstructionStore,
  userInstructionFeaturesEnabled,
  validateInstructions,
  validateRulesetName,
  type UserInstructionRuleset,
} from "./userInstructionStore.js";
import { previewUserInstructions } from "../utils/userInstructions.js";
import { RULESET_TOOLS } from "./rulesetToolDefinitions.js";
export { RULESET_TOOLS } from "./rulesetToolDefinitions.js";

export interface RulesetToolRun {
  id: string;
  cleanup?: () => Promise<void>;
}

export interface RulesetToolContext {
  requester?: AccessSubject;
  access?: AccessPolicy;
  guildId?: string | null;
}

export function createRulesetToolRun(): RulesetToolRun {
  return { id: randomUUID() };
}

export class RulesetTools {
  readonly id: string;
  readonly controller = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private calls = 0;

  constructor(
    readonly run: RulesetToolRun,
    readonly context: RulesetToolContext,
    private readonly store = new UserInstructionStore(),
  ) {
    this.id = run.id;
    run.cleanup = () => this.close();
  }

  async cancel(): Promise<void> {
    this.controller.abort();
    await this.queue.catch(() => {});
  }

  async close(): Promise<void> {
    await this.cancel();
  }

  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const operation = this.queue.catch(() => {}).then(async () => {
      this.controller.signal.throwIfAborted();
      if (args.run_id !== this.id) throw new Error("This ruleset run has expired or belongs to another response.");
      if (++this.calls > 40) throw new Error("Ruleset tool call limit reached for this response.");
      const schema = RULESET_TOOLS.find((tool) => tool.name === name)?.inputSchema;
      if (!schema || Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))) throw new Error("Invalid ruleset tool arguments.");
      for (const key of schema.required) if (typeof args[key] !== "string" || !(args[key] as string).trim()) throw new Error(`Missing ${key}.`);
      for (const value of Object.values(args)) if (typeof value !== "string" || value.length > 8192) throw new Error("Tool arguments must be short strings.");
      if (name === "list_user_rulesets") return this.list(args);
      if (name === "get_user_ruleset") return this.get(args);
      if (name === "set_user_ruleset") return this.set(args);
      if (name === "append_user_ruleset") return this.append(args);
      if (name === "delete_user_ruleset") return this.delete(args);
      if (name === "clear_user_rulesets") return this.clear(args);
      if (name === "enable_user_ruleset") return this.enabled(args, true);
      if (name === "disable_user_ruleset") return this.enabled(args, false);
      if (name === "preview_user_rulesets") return this.preview(args);
      throw new Error("Unknown ruleset tool.");
    });
    this.queue = operation;
    return operation;
  }

  private canManage(targetUserId: string): boolean {
    return Boolean(this.context.access && this.context.requester
      && canManageUserInstructions(
        this.context.requester,
        targetUserId,
        this.context.access.can(this.context.requester, "ruleset.manage", { guildId: this.context.guildId ?? undefined }),
      ));
  }

  private requireManage(targetUserId: string): AccessSubject {
    if (!userInstructionFeaturesEnabled() || !this.context.requester || !this.context.access) {
      throw new Error("Ruleset management is unavailable for this run.");
    }
    if (!this.canManage(targetUserId)) throw new Error("You do not have permission to manage user rulesets for that Discord user.");
    return this.context.requester;
  }

  private target(args: Record<string, unknown>): string {
    const raw = String(args.user ?? "").trim();
    const match = raw.match(/^<@!?(\d+)>$/) ?? raw.match(/^(\d+)$/);
    if (!match) throw new Error("Provide a Discord user ID or mention.");
    return match[1];
  }

  private list(args: Record<string, unknown>): unknown {
    const target = this.target(args);
    this.requireManage(target);
    return { rulesets: this.store.listForUser(this.context.guildId ?? null, target, args.include_disabled === "true").map(toolRuleset) };
  }

  private get(args: Record<string, unknown>): unknown {
    const target = this.target(args);
    this.requireManage(target);
    const ruleset = this.store.get(this.context.guildId ?? null, target, String(args.name));
    if (!ruleset) throw new Error("Ruleset not found.");
    return { ruleset: toolRuleset(ruleset) };
  }

  private set(args: Record<string, unknown>): unknown {
    const target = this.target(args);
    const requester = this.requireManage(target);
    const instructions = validateInstructions(String(args.instructions));
    const name = args.name ? validateRulesetName(String(args.name)) : this.availableName(target, generatedRulesetName(instructions));
    const priority = args.priority ? Number(args.priority) : 100;
    if (!Number.isSafeInteger(priority)) throw new Error("Priority must be an integer.");
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

  private append(args: Record<string, unknown>): unknown {
    const target = this.target(args);
    const requester = this.requireManage(target);
    const ruleset = this.store.append(this.context.guildId ?? null, target, String(args.name), String(args.instructions), requester.userId);
    console.info(`[ruleset] append guild=${this.context.guildId ?? "DM"} target=${ruleset.targetUserId} by=${requester.userId} name=${ruleset.name}`);
    return { status: "updated", ruleset: toolRuleset(ruleset) };
  }

  private delete(args: Record<string, unknown>): unknown {
    const target = this.target(args);
    const requester = this.requireManage(target);
    const name = validateRulesetName(String(args.name));
    const deleted = this.store.delete(this.context.guildId ?? null, target, name);
    console.info(`[ruleset] delete guild=${this.context.guildId ?? "DM"} target=${target} by=${requester.userId} name=${name}`);
    return { status: deleted ? "deleted" : "not_found", name };
  }

  private clear(args: Record<string, unknown>): unknown {
    const target = this.target(args);
    const requester = this.requireManage(target);
    const deleted = this.store.clear(this.context.guildId ?? null, target);
    console.info(`[ruleset] clear guild=${this.context.guildId ?? "DM"} target=${target} by=${requester.userId} count=${deleted}`);
    return { status: "cleared", deleted };
  }

  private enabled(args: Record<string, unknown>, enabled: boolean): unknown {
    const target = this.target(args);
    const requester = this.requireManage(target);
    const ruleset = this.store.setEnabled(this.context.guildId ?? null, target, String(args.name), enabled, requester.userId);
    console.info(`[ruleset] ${enabled ? "enable" : "disable"} guild=${this.context.guildId ?? "DM"} target=${ruleset.targetUserId} by=${requester.userId} name=${ruleset.name}`);
    return { status: enabled ? "enabled" : "disabled", ruleset: toolRuleset(ruleset) };
  }

  private preview(args: Record<string, unknown>): unknown {
    const userId = this.target(args);
    this.requireManage(userId);
    return {
      preview: previewUserInstructions(
        { guildId: this.context.guildId ?? null, userId },
        args.include_disabled === "true",
        this.store,
      ),
    };
  }

  private availableName(targetUserId: string, desired: string): string {
    const base = normalizeRulesetName(desired) || "user-rule";
    if (!this.store.get(this.context.guildId ?? null, targetUserId, base)) return base;
    for (let index = 2; index <= 99; index++) {
      const candidate = normalizeRulesetName(`${base}-${index}`);
      if (!this.store.get(this.context.guildId ?? null, targetUserId, candidate)) return candidate;
    }
    throw new Error("Could not generate a unique ruleset name.");
  }
}

function toolRuleset(ruleset: UserInstructionRuleset): Record<string, unknown> {
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
