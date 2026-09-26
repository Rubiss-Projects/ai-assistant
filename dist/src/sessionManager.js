import { chunkForDiscord } from "./common/chunkForDiscord.js";
import { ProviderStore } from "./common/providerStore.js";
import { SessionStore } from "./common/sessionStore.js";
import { join } from "node:path";
import { createProvider, isValidProviderName } from "./providers/index.js";
import { PROVIDERS, normalizeProviderName, isUnsupported, RunTimeoutError, UnsupportedError } from "./providers/types.js";
import { participationEvaluatorConfig, evaluateWithJev, providerParticipationPrompt } from "./common/participationEvaluator.js";
import { randomUUID } from "node:crypto";
export { chunkForDiscord, isUnsupported, RunTimeoutError, UnsupportedError };
export function unsupportedMessage(err) {
    if (isUnsupported(err)) return `⚠️ ${err.message}`;
    return null;
}
export function runTimeoutMessage(err) {
    if (!(err instanceof RunTimeoutError)) return null;
    return err.cancellationConfirmed ? `⏱️ ${err.provider} reached its hard time limit, so the run was cancelled. Please try again.` : `⚠️ ${err.provider} reached its hard time limit, but cancellation could not be confirmed. It may still be running.`;
}
export class SessionManager {
    storeDirectory;
    name;
    displayName;
    providers = new Map();
    stopping = false;
    overrides = new Map();
    store;
    constructor(defaultName, store, storeDirectory){
        this.storeDirectory = storeDirectory;
        const name = normalizeProviderName(defaultName ?? process.env.PROVIDER);
        if (!isValidProviderName(name)) {
            throw new Error(`Unknown PROVIDER "${name}". Choose one of: ${PROVIDERS.join(", ")}.`);
        }
        this.store = store ?? new ProviderStore(storeDirectory ? join(storeDirectory, 'providers.json') : undefined);
        this.name = name;
        this.displayName = this.getProvider(name).displayName;
        for (const [key, provider] of Object.entries(this.store.all())){
            if (isValidProviderName(provider)) this.overrides.set(key, provider);
        }
    }
    getProvider(name) {
        this.assertAcceptingWork();
        let provider = this.providers.get(name);
        if (!provider) {
            provider = createProvider(name, this.storeDirectory ? new SessionStore(name, join(this.storeDirectory, `sessions-${name}.json`)) : undefined);
            this.providers.set(name, provider);
        }
        return provider;
    }
    providerFor(key) {
        const name = key ? this.activeProviderName(key) : this.name;
        return this.getProvider(name);
    }
    activeProviderName(key) {
        if (key) {
            const override = this.overrides.get(key);
            if (override) return override;
        }
        return this.name;
    }
    activeProviderDisplayName(key) {
        return this.getProvider(this.activeProviderName(key)).displayName;
    }
    listAvailableProviders() {
        return [
            ...PROVIDERS
        ];
    }
    setSessionProvider(key, providerName) {
        this.assertAcceptingWork();
        const name = providerName.trim().toLowerCase();
        if (!isValidProviderName(name)) {
            throw new Error(`Unknown provider "${providerName}". Choose: ${PROVIDERS.join(", ")}.`);
        }
        if (name === this.name) {
            this.overrides.delete(key);
            this.store.delete(key);
        } else {
            this.overrides.set(key, name);
            this.store.set(key, name);
        }
        return Promise.resolve();
    }
    async shutdown() {
        this.stopping = true;
        const all = Array.from(this.providers.values());
        this.providers.clear();
        await Promise.all(all.map((p)=>p.shutdown()));
    }
    assertAcceptingWork() {
        if (this.stopping) throw new Error("Session manager is shutting down.");
    }
    sendMessage(userId, prompt, imagePaths, options) {
        return this.providerFor(userId).sendMessage(userId, prompt, imagePaths, options);
    }
    async evaluateParticipation(key, prompt) {
        this.assertAcceptingWork();
        const config = participationEvaluatorConfig();
        if (config.evaluator === "jev") return evaluateWithJev(prompt, config);
        const provider = this.providerFor(key);
        if (!provider.evaluateParticipation) throw new UnsupportedError(provider.displayName, "participation evaluation");
        const options = {
            ...config,
            ...provider.name === "opencode" ? {
                connectionModel: await provider.getCurrentModel(key)
            } : {}
        };
        this.assertAcceptingWork();
        return provider.evaluateParticipation(providerParticipationPrompt(prompt), options);
    }
    async runEphemeral(key, prompt) {
        const provider = this.providerFor(key);
        const temporaryKey = `internal_${randomUUID()}`;
        try {
            return (await provider.sendMessage(temporaryKey, prompt, undefined, {
                contextProfile: "ephemeral"
            })).content;
        } finally{
            await provider.resetSession(temporaryKey).catch((error)=>{
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
    async forgetSession(key) {
        const provider = this.providerFor(key);
        await (provider.forgetSession ? provider.forgetSession(key) : provider.resetSession(key));
        this.overrides.delete(key);
        this.store.delete(key);
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
