/** Live, opt-in evaluation against synthetic transcripts. Never connects to Discord. */
import { config as loadEnv } from "dotenv";
import { evaluateWithJev, participationEvaluatorConfig, providerParticipationPrompt } from "../src/common/participationEvaluator.js";
import { parseParticipationDecision } from "../src/common/chatParticipation.js";
import { participationScenarios } from "./fixtures/participationScenarios.js";
import { createProvider } from "../src/providers/index.js";

loadEnv({ quiet: true });
const evaluator = process.argv[2] ?? "jev";
if (!["jev", "copilot", "codex", "opencode"].includes(evaluator)) throw new Error("Choose jev, copilot, codex, or opencode.");
const config = participationEvaluatorConfig({ ...process.env, CHAT_PARTICIPATION_EVALUATOR: evaluator === "jev" ? "jev" : "provider" });
const provider = evaluator === "jev" ? undefined : createProvider(evaluator);
let passed = 0;
const durations: number[] = [];
try {
  for (const scenario of participationScenarios) {
    const candidateIds = scenario.candidateIds ?? [scenario.messages.at(-1)!.id];
    const prompt = JSON.stringify({ candidateIds, replyCooldown: false, reactionCooldown: false, messages: scenario.messages });
    const start = performance.now();
    let raw: string;
    try {
      raw = provider
        ? await provider.evaluateParticipation!(providerParticipationPrompt(prompt), config)
        : await evaluateWithJev(prompt, config);
    } catch {
      console.error(`${scenario.name}: evaluator request failed (check login/key, model and timeout).`);
      process.exitCode = 1;
      break;
    }
    const ms = performance.now() - start;
    durations.push(ms);
    const decision = parseParticipationDecision(raw, candidateIds);
    let wellFormed = false;
    try {
      const parsed = JSON.parse(raw);
      wellFormed = parsed?.action === "ignore" || decision.action !== "ignore";
    } catch { /* Invalid output must not masquerade as a correct ignore. */ }
    const valid = wellFormed && scenario.expected.includes(decision.action);
    if (valid) passed++;
    console.log(`${valid ? "PASS" : "FAIL"} ${scenario.name}: ${decision.action} (${Math.round(ms)} ms)`);
  }
  if (durations.length) {
    durations.sort((a, b) => a - b);
    console.log(`${evaluator}: ${passed}/${participationScenarios.length} expected decisions; median ${Math.round(durations[Math.floor(durations.length / 2)])} ms; max ${Math.round(durations.at(-1)!)} ms.`);
  }
  if (passed !== participationScenarios.length) process.exitCode = 1;
} finally {
  await provider?.shutdown();
}
