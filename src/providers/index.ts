import { CopilotProvider } from "./copilot.js";
import { CodexProvider } from "./codex.js";
import { OpenCodeProvider } from "./opencode.js";
import { PROVIDERS, type Provider, type ProviderName } from "./types.js";
import type { SessionStore } from "../common/sessionStore.js";

/**
 * Resolves the active provider name from the PROVIDER env var.
 * Defaults to "copilot" (GitHub Copilot) for backward compatibility.
 */
export function configuredProviderName(): string {
  const raw = (process.env.PROVIDER ?? "copilot").trim().toLowerCase();
  return raw || "copilot";
}

export function isValidProviderName(name: string): boolean {
  return (PROVIDERS as readonly string[]).includes(name.toLowerCase());
}

export function createProvider(name?: string, store?: SessionStore): Provider {
  const provider = (name ?? configuredProviderName()).toLowerCase() as ProviderName;
  switch (provider) {
    case "copilot":
      return new CopilotProvider(store);
    case "codex":
      return new CodexProvider(undefined, store);
    case "opencode":
      return new OpenCodeProvider(store);
    default:
      throw new Error(
        `Unknown PROVIDER "${provider}". Choose one of: ${PROVIDERS.join(", ")}.`
      );
  }
}
