import { CopilotProvider } from "./copilot.js";
import { CodexProvider } from "./codex.js";
import { OpenCodeProvider } from "./opencode.js";
import { ClaudeProvider } from "./claude.js";
import { normalizeProviderName, PROVIDERS, type Provider, type ProviderName } from "./types.js";
import type { SessionStore } from "../common/sessionStore.js";

/** Resolves the active provider name from the PROVIDER env var, defaulting to Codex. */
export function configuredProviderName(): string {
  return normalizeProviderName(process.env.PROVIDER);
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
    case "claude":
      return new ClaudeProvider(store);
    default:
      throw new Error(
        `Unknown PROVIDER "${provider}". Choose one of: ${PROVIDERS.join(", ")}.`
      );
  }
}
