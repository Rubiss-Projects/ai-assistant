export function configuredMilliseconds(key, fallback, minimum = 10) {
    const parsed = Number(process.env[key]);
    return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
export function startProgressUpdates(options) {
    if (!options?.onProgress)
        return () => { };
    const intervalMs = configuredMilliseconds("AI_PROGRESS_INTERVAL_MS", 60_000);
    const startedAt = Date.now();
    const timer = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        Promise.resolve(options.onProgress?.({ elapsedMs, message: "The agent is still working." }))
            .catch((error) => console.warn("[provider] Progress callback failed:", error));
    }, intervalMs);
    return () => clearInterval(timer);
}
