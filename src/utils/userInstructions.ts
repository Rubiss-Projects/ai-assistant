import {
  configuredUserInstructionMode,
  USER_RULESET_LIMITS,
  UserInstructionStore,
  type UserInstructionRuleset,
} from "../common/userInstructionStore.js";
import { providerSystemPrompt } from "../common/systemPrompt.js";

export interface UserInstructionContext {
  guildId?: string | null;
  userId: string;
  userDisplayName?: string;
}

export function formatUserInstructionBlock(
  context: UserInstructionContext,
  rulesets: readonly UserInstructionRuleset[],
): string {
  if (!rulesets.length) return "";
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

export function applyUserInstructions(
  prompt: string,
  context: UserInstructionContext,
  store = new UserInstructionStore(),
): string {
  if (configuredUserInstructionMode() === "off") return prompt;
  const rulesets = store.listForUser(context.guildId ?? null, context.userId, false);
  const block = formatUserInstructionBlock(context, rulesets);
  if (!block) return prompt;
  return `${block}\n\nUser message:\n${prompt}`;
}

export function activeUserInstructionBlock(
  context?: UserInstructionContext,
  store = new UserInstructionStore(),
): string {
  if (!context || configuredUserInstructionMode() === "off") return "";
  const rulesets = store.listForUser(context.guildId ?? null, context.userId, false);
  return formatUserInstructionBlock(context, rulesets);
}

export function providerSystemPromptForUser(
  context?: UserInstructionContext,
  store = new UserInstructionStore(),
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
  return formatUserInstructionBlock(context, rulesets) || "No enabled rulesets apply.";
}
