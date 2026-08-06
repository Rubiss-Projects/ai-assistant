export const PROVIDERS = ["copilot", "codex", "opencode"];
export class UnsupportedError extends Error {
    constructor(providerName, feature) {
        super(`The **${providerName}** provider does not support **${feature}**.`);
        this.name = "UnsupportedError";
    }
}
export function isUnsupported(err) {
    return err instanceof UnsupportedError;
}
/** Canonical list of reasoning-effort levels shared across providers that support it. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
export const DEFAULT_REASONING_EFFORT = "low";
