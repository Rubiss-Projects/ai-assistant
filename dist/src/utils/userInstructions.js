import { configuredUserInstructionMode, USER_RULESET_LIMITS, UserInstructionStore, } from "../common/userInstructionStore.js";
export function formatUserInstructionBlock(context, rulesets) {
    if (!rulesets.length)
        return "";
    const identity = context.userDisplayName
        ? `${context.userDisplayName} (${context.userId})`
        : context.userId;
    const blocks = rulesets.map((ruleset) => `Ruleset: ${ruleset.name}\n${ruleset.instructions}`);
    const content = [
        "Additional Discord user instructions:",
        "The following admin-configured instructions are part of the active system behavior for this Discord user.",
        "",
        `Target Discord user: ${identity}`,
        `Server: ${context.guildId ?? "DM"}`,
        "",
        ...blocks,
    ].join("\n");
    if (content.length > USER_RULESET_LIMITS.maxInjectedBlockLength) {
        throw new Error(`User instruction block exceeds ${USER_RULESET_LIMITS.maxInjectedBlockLength} characters.`);
    }
    return content;
}
export function applyUserInstructions(prompt, context, store = new UserInstructionStore()) {
    if (configuredUserInstructionMode() === "off")
        return prompt;
    const rulesets = store.listForUser(context.guildId ?? null, context.userId, false);
    const block = formatUserInstructionBlock(context, rulesets);
    if (!block)
        return prompt;
    return `${block}\n\nUser message:\n${prompt}`;
}
export function previewUserInstructions(context, includeDisabled = false, store = new UserInstructionStore()) {
    const rulesets = store.listForUser(context.guildId ?? null, context.userId, includeDisabled);
    return formatUserInstructionBlock(context, rulesets) || "No enabled rulesets apply.";
}
