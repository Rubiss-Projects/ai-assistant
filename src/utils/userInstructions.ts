import {
  configuredUserInstructionMode,
  formatUserInstructionBlock as formatStoredUserInstructionBlock,
  USER_RULESET_LIMITS,
  UserInstructionStore,
  validateUserInstructionBlockLength,
  type UserInstructionContext,
  type UserInstructionRuleset,
} from "../common/userInstructionStore.js";
import { providerSystemPrompt } from "../common/systemPrompt.js";

export type { UserInstructionContext } from "../common/userInstructionStore.js";

export function formatUserInstructionBlock(
  context: UserInstructionContext,
  rulesets: readonly UserInstructionRuleset[],
): string {
  let content = formatStoredUserInstructionBlock(context, rulesets);
  if (content.length > USER_RULESET_LIMITS.maxInjectedBlockLength) {
    content = formatStoredUserInstructionBlock({ ...context, userDisplayName: undefined }, rulesets);
    validateUserInstructionBlockLength({ ...context, userDisplayName: undefined }, rulesets);
  }
  return content;
}

export function applyUserInstructions(
  prompt: string,
  context: UserInstructionContext,
  store?: UserInstructionStore,
): string {
  if (configuredUserInstructionMode() === "off") return prompt;
  const rulesets = (store ?? new UserInstructionStore()).listForUser(context.guildId ?? null, context.userId, false);
  const block = formatUserInstructionBlock(context, rulesets);
  if (!block) return prompt;
  return `${block}\n\nUser message:\n${prompt}`;
}

export function activeUserInstructionBlock(
  context?: UserInstructionContext,
  store?: UserInstructionStore,
): string {
  if (!context || configuredUserInstructionMode() === "off") return "";
  const rulesets = (store ?? new UserInstructionStore()).listForUser(context.guildId ?? null, context.userId, false);
  return formatUserInstructionBlock(context, rulesets);
}

export function providerSystemPromptForUser(
  context?: UserInstructionContext,
  store?: UserInstructionStore,
): string {
  return [providerSystemPrompt(), activeUserInstructionBlock(context, store)]
    .filter(Boolean)
    .join("\n\n");
}

export function previewUserInstructions(
  context: UserInstructionContext,
  includeDisabled = false,
  store = new UserInstructionStore(),
): string {
  const rulesets = store.listForUser(context.guildId ?? null, context.userId, includeDisabled);
  const block = includeDisabled
    ? formatStoredUserInstructionBlock(context, rulesets)
    : formatUserInstructionBlock(context, rulesets);
  return block || "No enabled rulesets apply.";
}
