import { chunkForDiscord } from "./common/chunkForDiscord.js";
import { ProviderStore } from "./common/providerStore.js";
import { createProvider, isValidProviderName } from "./providers/index.js";
import { PROVIDERS, isUnsupported, RunTimeoutError, UnsupportedError } from "./providers/types.js";
import { randomUUID } from "node:crypto";
export { chunkForDiscord, isUnsupported, RunTimeoutError, UnsupportedError };
/**
 * Returns a friendly Discord-safe message for an UnsupportedError, or null when
 * the error is not one. Handlers use this so unsupported provider features show
 * a clean "__provider__ does not support X" instead of the generic error.
 */
export function unsupportedMessage(err) {
    if (isUnsupported(err))
        return `⚠️ ${err.message}`;
    return null;
}
export function runTimeoutMessage(err) {
    if (!(err instanceof RunTimeoutError))
        return null;
    return err.cancellationConfirmed
        ? `⏱️ ${err.provider} reached its hard time limit, so the run was cancelled. Please try again.`
        : `⚠️ ${err.provider} reached its hard time limit, but cancellation could not be confirmed. It may still be running.`;
}
/**
 * Facade in front of all AI providers (Copilot / Codex / OpenCode).
 *
 * The whole Discord layer (bot, commands, handlers) talks only to this class.
 * It can host any number of providers at once and lets a Discord session key
 * (user ID or thread ID) pick its active provider at runtime (`/provider set`),
 * so you can switch between e.g. Codex and OpenCode without restarting.
 *
 * Providers are created lazily and cached. Each provider keeps its own session
 * history per key (namespaced on disk), so switching back to a provider resumes
 * that provider's own thread for the key.
 *
 * Methods a provider doesn't support throw `UnsupportedError`, which handlers
 * render as a friendly in-Discord message.
 */
export class SessionManager {
    /** Default provider name, from the PROVIDER env var unless overridden. */
    name;
    /** Default provider display name. */
    displayName;
    providers = new Map();
    overrides = new Map(); // session key -> provider name
    store;
    constructor(defaultName, store) {
        const name = (defaultName ?? process.env.PROVIDER ?? "copilot").trim().toLowerCase() || "copilot";
        if (!isValidProviderName(name)) {
            throw new Error(`Unknown PROVIDER "${name}". Choose one of: ${PROVIDERS.join(", ")}.`);
        }
        this.store = store ?? new ProviderStore();
        this.name = name;
        this.displayName = this.getProvider(name).displayName;
        // Hydrate persisted per-key overrides.
        for (const [key, provider] of Object.entries(this.store.all())) {
            if (isValidProviderName(provider))
                this.overrides.set(key, provider);
        }
    }
    // ── Provider selection ──────────────────────────────────────────────────────
    getProvider(name) {
        let provider = this.providers.get(name);
        if (!provider) {
            provider = createProvider(name);
            this.providers.set(name, provider);
        }
        return provider;
    }
    /** Resolve the active provider instance for a session key (or default). */
    providerFor(key) {
        const name = key ? this.activeProviderName(key) : this.name;
        return this.getProvider(name);
    }
    /** Active provider name for a session key, falling back to the default. */
    activeProviderName(key) {
        if (key) {
            const override = this.overrides.get(key);
            if (override)
                return override;
        }
        return this.name;
    }
    /** Active provider display name for a session key. */
    activeProviderDisplayName(key) {
        return this.getProvider(this.activeProviderName(key)).displayName;
    }
    /** Names of all providers this build can run. */
    listAvailableProviders() {
        return [...PROVIDERS];
    }
    /**
     * Set the active provider for a session key. The new provider resumes its own
     * prior thread for the key (if any); no session data is discarded. Passing the
     * default provider name clears the override.
     */
    setSessionProvider(key, providerName) {
        const name = providerName.trim().toLowerCase();
        if (!isValidProviderName(name)) {
            throw new Error(`Unknown provider "${providerName}". Choose: ${PROVIDERS.join(", ")}.`);
        }
        if (name === this.name) {
            this.overrides.delete(key);
            this.store.delete(key);
        }
        else {
            this.overrides.set(key, name);
            this.store.set(key, name);
        }
        return Promise.resolve();
    }
    async shutdown() {
        const all = Array.from(this.providers.values());
        this.providers.clear();
        await Promise.all(all.map((p) => p.shutdown()));
    }
    // ── Chat & session operations (delegated to the active provider for key) ────
    sendMessage(userId, prompt, imagePaths, options) {
        return this.providerFor(userId).sendMessage(userId, prompt, imagePaths, options);
    }
    /** Run an internal one-shot inference without adding it to the user's conversation. */
    async runEphemeral(key, prompt) {
        const provider = this.providerFor(key);
        const temporaryKey = `internal_${randomUUID()}`;
        try {
            return await provider.sendMessage(temporaryKey, prompt);
        }
        finally {
            await provider.resetSession(temporaryKey).catch((error) => {
                console.warn("[SessionManager] Could not clean up internal session:", error);
            });
        }
    }
    getStatus(key) {
        return this.providerFor(key).getStatus();
    }
    getHistory(userId) {
        return this.providerFor(userId).getHistory(userId);
    }
    listModels(key) {
        return this.providerFor(key).listModels();
    }
    setModel(userId, model) {
        return this.providerFor(userId).setModel(userId, model);
    }
    getCurrentModel(key) {
        return this.providerFor(key).getCurrentModel(key);
    }
    listReasoningEfforts(key) {
        return this.providerFor(key).listReasoningEfforts();
    }
    setReasoningEffort(key, effort) {
        return this.providerFor(key).setReasoningEffort(key, effort);
    }
    getCurrentReasoningEffort(key) {
        return this.providerFor(key).getCurrentReasoningEffort(key);
    }
    listAgents(key) {
        return this.providerFor(key).listAgents(key);
    }
    getCurrentAgent(key) {
        return this.providerFor(key).getCurrentAgent(key);
    }
    selectAgent(key, name) {
        return this.providerFor(key).selectAgent(key, name);
    }
    deselectAgent(key) {
        return this.providerFor(key).deselectAgent(key);
    }
    getMode(key) {
        return this.providerFor(key).getMode(key);
    }
    setMode(key, mode) {
        return this.providerFor(key).setMode(key, mode);
    }
    compact(key) {
        return this.providerFor(key).compact(key);
    }
    startFleet(key, prompt) {
        return this.providerFor(key).startFleet(key, prompt);
    }
    readPlan(key) {
        return this.providerFor(key).readPlan(key);
    }
    updatePlan(key, content) {
        return this.providerFor(key).updatePlan(key, content);
    }
    deletePlan(key) {
        return this.providerFor(key).deletePlan(key);
    }
    listWorkspaceFiles(key) {
        return this.providerFor(key).listWorkspaceFiles(key);
    }
    readWorkspaceFile(key, filePath) {
        return this.providerFor(key).readWorkspaceFile(key, filePath);
    }
    createWorkspaceFile(key, filePath, content) {
        return this.providerFor(key).createWorkspaceFile(key, filePath, content);
    }
    resetSession(key) {
        return this.providerFor(key).resetSession(key);
    }
    setSessionWorkingDir(key, dir) {
        return this.providerFor(key).setSessionWorkingDir(key, dir);
    }
    getSessionWorkingDir(key) {
        return this.providerFor(key).getSessionWorkingDir(key);
    }
    setSessionMcpEnabled(key, serverName, enabled) {
        return this.providerFor(key).setSessionMcpEnabled(key, serverName, enabled);
    }
    getMcpStatus(key) {
        return this.providerFor(key).getMcpStatus(key);
    }
}
