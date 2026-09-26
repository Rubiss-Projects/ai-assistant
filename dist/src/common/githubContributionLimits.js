/** Host configuration only. Null is the JSON-safe representation of unlimited. */
export function githubContributionLimits(env = process.env) {
    const limit = (name) => {
        const raw = env[name]?.trim() || "20";
        const value = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
            throw new Error(`${name} must be a non-negative safe integer (0 means unlimited).`);
        }
        return value === 0 ? null : value;
    };
    return {
        publish: limit("GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT"),
        reviews: limit("CODEX_REVIEW_LIMIT"),
    };
}
