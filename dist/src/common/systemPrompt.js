import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const ENV_KEY = "AI_ASSISTANT_SYSTEM_PROMPT";
const FILE_KEY = "AI_ASSISTANT_SYSTEM_PROMPT_FILE";
/** Read the operator's optional instructions. A file takes precedence over inline text. */
export function configuredSystemPrompt() {
    const file = process.env[FILE_KEY]?.trim();
    if (file) {
        const filePath = resolve(file);
        let content;
        try {
            content = readFileSync(filePath, "utf8");
        }
        catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`Could not read ${FILE_KEY} (${filePath}): ${detail}`);
        }
        return content.trim() || undefined;
    }
    return process.env[ENV_KEY]?.trim() || undefined;
}
/** Fallback for providers without a native system/developer-message option. */
export function withSystemPrompt(prompt) {
    const systemPrompt = configuredSystemPrompt();
    if (!systemPrompt)
        return prompt;
    return `<operator-instructions>\n${systemPrompt}\n</operator-instructions>\n\n${prompt}`;
}
