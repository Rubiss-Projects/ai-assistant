import { CopilotProvider } from "./copilot.js";
import { CodexProvider } from "./codex.js";
import { OpenCodeProvider } from "./opencode.js";
import { PROVIDERS } from "./types.js";
/**
 * Resolves the active provider name from the PROVIDER env var.
 * Defaults to "copilot" (GitHub Copilot) for backward compatibility.
 */
export function configuredProviderName() {
    const raw = (process.env.PROVIDER ?? "copilot").trim().toLowerCase();
    return raw || "copilot";
}
export function isValidProviderName(name) {
    return PROVIDERS.includes(name.toLowerCase());
}
export function createProvider(name, store) {
    const provider = (name ?? configuredProviderName()).toLowerCase();
    switch (provider) {
        case "copilot":
            return new CopilotProvider(store);
        case "codex":
            return new CodexProvider(undefined, store);
        case "opencode":
            return new OpenCodeProvider(store);
        default:
            throw new Error(`Unknown PROVIDER "${provider}". Choose one of: ${PROVIDERS.join(", ")}.`);
    }
}
