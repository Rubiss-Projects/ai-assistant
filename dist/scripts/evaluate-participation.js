/** Live, opt-in evaluation against synthetic transcripts. Never connects to Discord. */
import { config as loadEnv } from "dotenv";
import { InvalidParticipationResponseError, evaluateWithJev, participationEvaluatorConfig, providerParticipationPrompt } from "../src/common/participationEvaluator.js";
import { DEFAULT_PARTICIPATION_EMOJIS } from "../src/common/chatParticipation.js";
import { participationScenarios } from "./fixtures/participationScenarios.js";
import { assessParticipation } from "./participationEvaluation.js";
import { createProvider } from "../src/providers/index.js";
loadEnv({ quiet: true });
const evaluator = process.argv[2] ?? "jev";
if (!["jev", "copilot", "codex", "opencode"].includes(evaluator))
    throw new Error("Choose jev, copilot, codex, or opencode.");
const config = participationEvaluatorConfig({ ...process.env, CHAT_PARTICIPATION_EVALUATOR: evaluator === "jev" ? "jev" : "provider" });
const provider = evaluator === "jev" ? undefined : createProvider(evaluator);
let passed = 0;
let invalidResponses = 0;
let requestFailures = 0;
const durations = [];
try {
    for (const scenario of participationScenarios) {
        const candidateIds = scenario.candidateIds ?? [scenario.messages.at(-1).id];
        const prompt = JSON.stringify({ assistant: { id: "bot", names: ["Rook", "AI Assistant"] }, candidateIds, availableEmojis: scenario.availableEmojis ?? DEFAULT_PARTICIPATION_EMOJIS, replyCooldown: scenario.replyCooldown ?? false, reactionCooldown: scenario.reactionCooldown ?? false, messages: scenario.messages });
        const start = performance.now();
        let raw;
        try {
            raw = provider
                ? await provider.evaluateParticipation(providerParticipationPrompt(prompt), config)
                : await evaluateWithJev(prompt, config);
        }
        catch (error) {
            if (error instanceof InvalidParticipationResponseError) {
                invalidResponses++;
                console.error(`${scenario.name}: invalid evaluator response.`);
            }
            else {
                requestFailures++;
                console.error(`${scenario.name}: evaluator request failed (check login/key, model, request budget and timeout).`);
            }
            process.exitCode = 1;
            continue;
        }
        const ms = performance.now() - start;
        durations.push(ms);
        const result = assessParticipation(raw, scenario);
        if (!result.valid)
            invalidResponses++;
        if (result.passed)
            passed++;
        console.log(`${result.passed ? "PASS" : "FAIL"} ${scenario.name}: ${JSON.stringify(result.decision) ?? "invalid output"}; activity=${result.activity} (${Math.round(ms)} ms)`);
    }
    if (durations.length) {
        durations.sort((a, b) => a - b);
        console.log(`${evaluator}: ${passed}/${participationScenarios.length} expected decisions; median ${Math.round(durations[Math.floor(durations.length / 2)])} ms; max ${Math.round(durations.at(-1))} ms.`);
    }
    console.log(`Invalid responses: ${invalidResponses}; request failures: ${requestFailures}.`);
    if (passed !== participationScenarios.length)
        process.exitCode = 1;
}
finally {
    await provider?.shutdown();
}
