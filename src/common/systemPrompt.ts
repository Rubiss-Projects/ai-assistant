import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARTIFACT_INSTRUCTIONS } from "./agentResponse.js";

const ENV_KEY = "AI_ASSISTANT_SYSTEM_PROMPT";
const FILE_KEY = "AI_ASSISTANT_SYSTEM_PROMPT_FILE";

/** Read the operator's optional instructions. A file takes precedence over inline text. */
export function configuredSystemPrompt(): string | undefined {
  const file = process.env[FILE_KEY]?.trim();
  if (file) {
    const filePath = resolve(file);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read ${FILE_KEY} (${filePath}): ${detail}`);
    }
    return content.trim() || undefined;
  }
  return process.env[ENV_KEY]?.trim() || undefined;
}

/** Built-in protocol plus optional operator instructions sent to every provider. */
export function providerSystemPrompt(): string {
  return [configuredSystemPrompt(), ARTIFACT_INSTRUCTIONS].filter(Boolean).join("\n\n");
}

/** Fallback for providers without a native system/developer-message option. */
export function withSystemPrompt(prompt: string): string {
  const systemPrompt = providerSystemPrompt();
  return `<operator-instructions>\n${systemPrompt}\n</operator-instructions>\n\n${prompt}`;
}
