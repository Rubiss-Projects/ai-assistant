import { configuredUserInstructionMode, formatUserInstructionBlock as formatStoredUserInstructionBlock, USER_RULESET_LIMITS, UserInstructionStore, validateUserInstructionBlockLength, } from "../common/userInstructionStore.js";
import { providerSystemPrompt } from "../common/systemPrompt.js";
export function formatUserInstructionBlock(context, rulesets) {
    let content = formatStoredUserInstructionBlock(context, rulesets);
    if (content.length > USER_RULESET_LIMITS.maxInjectedBlockLength) {
        content = formatStoredUserInstructionBlock({ ...context, userDisplayName: undefined }, rulesets);
        validateUserInstructionBlockLength({ ...context, userDisplayName: undefined }, rulesets);
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
export function activeUserInstructionBlock(context, store = new UserInstructionStore()) {
    if (!context || configuredUserInstructionMode() === "off")
        return "";
    const rulesets = store.listForUser(context.guildId ?? null, context.userId, false);
    return formatUserInstructionBlock(context, rulesets);
}
export function providerSystemPromptForUser(context, store = new UserInstructionStore()) {
    return [providerSystemPrompt(), activeUserInstructionBlock(context, store)]
        .filter(Boolean)
        .join("\n\n");
}
export function previewUserInstructions(context, includeDisabled = false, store = new UserInstructionStore()) {
    const rulesets = store.listForUser(context.guildId ?? null, context.userId, includeDisabled);
    return formatUserInstructionBlock(context, rulesets) || "No enabled rulesets apply.";
}
