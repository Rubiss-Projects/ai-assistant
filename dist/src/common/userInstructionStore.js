import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "node:crypto";
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
export function userInstructionRulesetsFile(env = process.env) {
    return env.USER_INSTRUCTION_RULESETS_FILE?.trim()
        || path.join(os.homedir(), ".config", "ai-assistant", "user-instructions.json");
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
export class UserInstructionStore {
    filePath;
    rulesets = [];
    constructor(filePath = userInstructionRulesetsFile()) {
        this.filePath = filePath;
        this.load();
    }
    load() {
        try {
            const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            this.rulesets = Array.isArray(value) ? value.filter(isRuleset) : [];
        }
        catch {
            this.rulesets = [];
        }
    }
    all() {
        return [...this.rulesets];
    }
    listForUser(guildId, targetUserId, includeDisabled = false) {
        const normalizedGuild = guildId ?? null;
        return this.rulesets
            .filter((ruleset) => ruleset.targetUserId === targetUserId
            && (ruleset.scope === "global" || ruleset.guildId === normalizedGuild)
            && (includeDisabled || ruleset.enabled))
            .sort(compareRulesets);
    }
    get(guildId, targetUserId, name) {
        const normalizedGuild = guildId ?? null;
        const normalizedName = validateRulesetName(name);
        return this.rulesets.find((ruleset) => ruleset.targetUserId === targetUserId
            && ruleset.name === normalizedName
            && ruleset.guildId === normalizedGuild);
    }
    set(input) {
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
        this.rulesets = existing
            ? this.rulesets.map((item) => item.id === existing.id ? ruleset : item)
            : [...this.rulesets, ruleset];
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
        const normalizedGuild = guildId ?? null;
        const normalizedName = validateRulesetName(name);
        const before = this.rulesets.length;
        this.rulesets = this.rulesets.filter((ruleset) => !(ruleset.guildId === normalizedGuild && ruleset.targetUserId === targetUserId && ruleset.name === normalizedName));
        if (this.rulesets.length !== before)
            this.persist();
        return this.rulesets.length !== before;
    }
    clear(guildId, targetUserId) {
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
    persist() {
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
function isRuleset(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const item = value;
    return typeof item.id === "string"
        && (typeof item.guildId === "string" || item.guildId === null)
        && typeof item.targetUserId === "string"
        && typeof item.name === "string"
        && typeof item.enabled === "boolean"
        && typeof item.priority === "number"
        && typeof item.instructions === "string"
        && typeof item.createdBy === "string"
        && typeof item.createdAt === "string"
        && typeof item.updatedBy === "string"
        && typeof item.updatedAt === "string";
}
