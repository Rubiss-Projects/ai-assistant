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
export class RunTimeoutError extends Error {
    provider;
    timeoutMs;
    cancellationConfirmed;
    constructor(provider, timeoutMs, cancellationConfirmed) {
        super(`${provider} exceeded its ${timeoutMs}ms hard timeout${cancellationConfirmed ? " and was cancelled" : "; cancellation could not be confirmed"}.`);
        this.provider = provider;
        this.timeoutMs = timeoutMs;
        this.cancellationConfirmed = cancellationConfirmed;
        this.name = "RunTimeoutError";
    }
}
/** Canonical list of reasoning-effort levels shared across providers that support it. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const DEFAULT_REASONING_EFFORT = "low";
