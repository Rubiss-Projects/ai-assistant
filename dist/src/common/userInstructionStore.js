import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "node:crypto";
import { configuredWorkspaceRoot, pathIsWithin } from "./providerSecurity.js";
export const USER_RULESET_LIMITS = {
    maxRulesetsPerUserGuild: 10,
    maxInstructionLength: 4000,
    maxInjectedBlockLength: 8000,
    maxNameLength: 64,
};
export function configuredUserInstructionMode(env = process.env) {
    const value = (env.USER_INSTRUCTION_MODE ?? "off").trim().toLowerCase();
    if (!value)
        return "off";
    if (["off", "admin_only", "admin_and_self", "unfiltered"].includes(value))
        return value;
    throw new Error("USER_INSTRUCTION_MODE must be off, admin_only, admin_and_self, or unfiltered.");
}
export function userInstructionFeaturesEnabled(env = process.env) {
    return configuredUserInstructionMode(env) !== "off";
}
export function canManageUserInstructions(requester, targetUserId, isAdmin, mode = configuredUserInstructionMode()) {
    if (mode === "off")
        return false;
    if (mode === "unfiltered")
        return Boolean(requester);
    if (mode === "admin_only")
        return isAdmin;
    return isAdmin || Boolean(requester && requester.userId === targetUserId);
}
export function userInstructionRulesetsFile(env = process.env) {
    const file = env.USER_INSTRUCTION_RULESETS_FILE?.trim()
        || path.join(os.homedir(), ".config", "ai-assistant", "user-instructions.json");
    validateStoragePath(file, env);
    return file;
}
/** Rules are host-managed policy, so provider file tools must not be able to edit them. */
function validateStoragePath(file, env = process.env) {
    const workspace = configuredWorkspaceRoot(env);
    if (!workspace)
        return;
    const relative = path.relative(path.resolve(workspace), path.resolve(file));
    const lexicallyInside = relative === ""
        || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
    if (lexicallyInside || pathIsWithin(workspace, file)) {
        throw new Error("USER_INSTRUCTION_RULESETS_FILE must be outside the provider workspace root, including symlink targets.");
    }
}
export function normalizeRulesetName(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, USER_RULESET_LIMITS.maxNameLength);
}
export function generatedRulesetName(instructions) {
    const compact = instructions
        .replace(/`([^`]+)`/g, "$1")
        .replace(/["']/g, "")
        .toLowerCase();
    if (/\bhello\b/.test(compact) && /\bworld\b/.test(compact))
        return "hello-world";
    if (/\btypescript\b/.test(compact))
        return "typescript-preference";
    if (/\b(short|brief|terse|concise)\b/.test(compact))
        return "short-replies";
    return normalizeRulesetName(compact.split(/\s+/).slice(0, 6).join("-")) || "user-rule";
}
export function validateRulesetName(name) {
    const normalized = normalizeRulesetName(name);
    if (!normalized || normalized !== name.trim()) {
        throw new Error("Ruleset names must use lowercase letters, numbers, dashes, or underscores.");
    }
    if (normalized.length > USER_RULESET_LIMITS.maxNameLength)
        throw new Error("Ruleset name is too long.");
    return normalized;
}
export function validateInstructions(instructions) {
    const trimmed = instructions.trim();
    if (!trimmed)
        throw new Error("Instructions are required.");
    if (trimmed.length > USER_RULESET_LIMITS.maxInstructionLength) {
        throw new Error(`Instructions must be ${USER_RULESET_LIMITS.maxInstructionLength} characters or fewer.`);
    }
    return trimmed;
}
export function formatUserInstructionBlock(context, rulesets) {
    if (!rulesets.length)
        return "";
    const identity = context.userDisplayName
        ? `${context.userDisplayName} (${context.userId})`
        : context.userId;
    const blocks = rulesets.map((ruleset) => `Ruleset: ${ruleset.name}\n${ruleset.instructions}`);
    return [
        "Additional Discord user instructions:",
        "The following admin-configured instructions are part of the active system behavior for this Discord user.",
        "",
        `Target Discord user: ${identity}`,
        `Server: ${context.guildId ?? "DM"}`,
        "",
        ...blocks,
    ].join("\n");
}
export function validateUserInstructionBlockLength(context, rulesets) {
    const content = formatUserInstructionBlock(context, rulesets);
    if (content.length > USER_RULESET_LIMITS.maxInjectedBlockLength) {
        throw new Error(`User instruction block exceeds ${USER_RULESET_LIMITS.maxInjectedBlockLength} characters.`);
    }
}
export class UserInstructionStore {
    filePath;
    rulesets = [];
    constructor(filePath = userInstructionRulesetsFile()) {
        this.filePath = filePath;
        this.load();
    }
    load() {
        validateStoragePath(this.filePath);
        try {
            const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (!Array.isArray(value) || !value.every(isRuleset))
                throw new Error("Invalid ruleset storage format.");
            // Validate restored combinations too, keeping unrelated users out of each scan.
            const byUser = new Map();
            for (const ruleset of value) {
                const group = byUser.get(ruleset.targetUserId) ?? [];
                group.push(ruleset);
                byUser.set(ruleset.targetUserId, group);
            }
            for (const group of byUser.values()) {
                for (const ruleset of group)
                    this.validateEnabledBlockFor(ruleset, group);
            }
            this.rulesets = value;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            this.rulesets = [];
        }
    }
    all() {
        this.load();
        return [...this.rulesets];
    }
    listForUser(guildId, targetUserId, includeDisabled = false) {
        this.load();
        const normalizedGuild = guildId ?? null;
        return this.rulesets
            .filter((ruleset) => ruleset.targetUserId === targetUserId
            && (ruleset.scope === "global" || ruleset.guildId === normalizedGuild)
            && (includeDisabled || ruleset.enabled))
            .sort(compareRulesets);
    }
    get(guildId, targetUserId, name) {
        this.load();
        const normalizedGuild = guildId ?? null;
        const normalizedName = validateRulesetName(name);
        return this.rulesets.find((ruleset) => ruleset.targetUserId === targetUserId
            && ruleset.name === normalizedName
            && ruleset.guildId === normalizedGuild);
    }
    /** Choose an unused generated name; explicit names still update the existing rule. */
    availableName(guildId, targetUserId, desired) {
        const base = normalizeRulesetName(desired) || "user-rule";
        for (let index = 1; index <= 99; index++) {
            const suffix = index === 1 ? "" : `-${index}`;
            const candidate = `${base.slice(0, USER_RULESET_LIMITS.maxNameLength - suffix.length)}${suffix}`;
            if (!this.get(guildId, targetUserId, candidate))
                return candidate;
        }
        throw new Error("Could not generate a unique ruleset name.");
    }
    set(input) {
        this.load();
        const now = new Date().toISOString();
        const guildId = input.scope === "global" ? null : input.guildId ?? null;
        const name = validateRulesetName(input.name);
        const instructions = validateInstructions(input.instructions);
        const existing = this.rulesets.find((ruleset) => ruleset.guildId === guildId
            && ruleset.targetUserId === input.targetUserId
            && ruleset.name === name);
        if (!existing) {
            const count = this.rulesets.filter((ruleset) => ruleset.guildId === guildId && ruleset.targetUserId === input.targetUserId).length;
            if (count >= USER_RULESET_LIMITS.maxRulesetsPerUserGuild)
                throw new Error("This user already has the maximum number of rulesets in this scope.");
        }
        const ruleset = {
            id: existing?.id ?? randomUUID(),
            guildId,
            targetUserId: input.targetUserId,
            name,
            enabled: input.enabled ?? existing?.enabled ?? true,
            priority: input.priority ?? existing?.priority ?? 100,
            mode: input.mode ?? existing?.mode ?? "append",
            scope: input.scope ?? existing?.scope ?? (guildId ? "guild" : "global"),
            instructions,
            createdBy: existing?.createdBy ?? input.createdBy,
            createdAt: existing?.createdAt ?? now,
            updatedBy: input.updatedBy ?? input.createdBy,
            updatedAt: now,
        };
        if (!isRuleset(ruleset))
            throw new Error("Invalid ruleset fields.");
        const nextRulesets = existing
            ? this.rulesets.map((item) => item.id === existing.id ? ruleset : item)
            : [...this.rulesets, ruleset];
        this.validateEnabledBlockFor(ruleset, nextRulesets);
        this.rulesets = nextRulesets;
        this.persist();
        return ruleset;
    }
    append(guildId, targetUserId, name, text, updatedBy) {
        const existing = this.get(guildId, targetUserId, name);
        if (!existing)
            throw new Error(`Ruleset ${name} does not exist.`);
        return this.set({
            ...existing,
            instructions: `${existing.instructions}\n${validateInstructions(text)}`,
            createdBy: existing.createdBy,
            updatedBy,
        });
    }
    delete(guildId, targetUserId, name) {
        this.load();
        const normalizedGuild = guildId ?? null;
        const normalizedName = validateRulesetName(name);
        const before = this.rulesets.length;
        this.rulesets = this.rulesets.filter((ruleset) => !(ruleset.guildId === normalizedGuild && ruleset.targetUserId === targetUserId && ruleset.name === normalizedName));
        if (this.rulesets.length !== before)
            this.persist();
        return this.rulesets.length !== before;
    }
    clear(guildId, targetUserId) {
        this.load();
        const normalizedGuild = guildId ?? null;
        const before = this.rulesets.length;
        this.rulesets = this.rulesets.filter((ruleset) => !(ruleset.guildId === normalizedGuild && ruleset.targetUserId === targetUserId));
        if (this.rulesets.length !== before)
            this.persist();
        return before - this.rulesets.length;
    }
    setEnabled(guildId, targetUserId, name, enabled, updatedBy) {
        const existing = this.get(guildId, targetUserId, name);
        if (!existing)
            throw new Error(`Ruleset ${name} does not exist.`);
        return this.set({ ...existing, enabled, createdBy: existing.createdBy, updatedBy });
    }
    validateEnabledBlockFor(changed, nextRulesets) {
        if (!changed.enabled)
            return;
        const guildIds = new Set([changed.guildId]);
        if (changed.scope === "global") {
            guildIds.add(null);
            // Global rules also apply in future guilds; Discord snowflakes can occupy 20 digits.
            guildIds.add("18446744073709551615");
            for (const ruleset of nextRulesets) {
                if (ruleset.targetUserId === changed.targetUserId && ruleset.guildId !== null)
                    guildIds.add(ruleset.guildId);
            }
        }
        for (const guildId of guildIds) {
            validateUserInstructionBlockLength({ guildId, userId: changed.targetUserId }, applicableRulesets(nextRulesets, guildId, changed.targetUserId));
        }
    }
    persist() {
        validateStoragePath(this.filePath);
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.rulesets, null, 2));
        fs.renameSync(temporary, this.filePath);
    }
}
function compareRulesets(a, b) {
    return a.priority - b.priority || a.name.localeCompare(b.name);
}
function applicableRulesets(rulesets, guildId, targetUserId) {
    return rulesets
        .filter((ruleset) => ruleset.targetUserId === targetUserId
        && ruleset.enabled
        && (ruleset.scope === "global" || ruleset.guildId === guildId))
        .sort(compareRulesets);
}
function isRuleset(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const item = value;
    if (!(typeof item.id === "string" && item.id.trim().length > 0
        && (item.guildId === null || (typeof item.guildId === "string" && item.guildId.trim().length > 0))
        && typeof item.targetUserId === "string" && item.targetUserId.trim().length > 0
        && typeof item.name === "string"
        && typeof item.enabled === "boolean"
        && Number.isSafeInteger(item.priority)
        && (item.scope === "guild" || item.scope === "global")
        && (item.mode === "append" || item.mode === "override")
        && typeof item.instructions === "string"
        && typeof item.createdBy === "string" && item.createdBy.trim().length > 0
        && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
        && typeof item.updatedBy === "string" && item.updatedBy.trim().length > 0
        && typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt))))
        return false;
    try {
        return validateRulesetName(item.name) === item.name
            && validateInstructions(item.instructions) === item.instructions;
    }
    catch {
        return false;
    }
}
