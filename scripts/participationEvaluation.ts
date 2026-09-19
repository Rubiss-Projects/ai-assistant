import { isDeepStrictEqual } from "node:util";
import { DEFAULT_PARTICIPATION_EMOJIS, participationAllowed, validateParticipationDecision } from "../src/common/chatParticipation.js";
import type { ParticipationScenario } from "./fixtures/participationScenarios.js";

export function assessParticipation(raw: string, scenario: ParticipationScenario) {
  const ids = scenario.candidateIds ?? [scenario.messages.at(-1)!.id];
  const decision = validateParticipationDecision(raw, ids, scenario.availableEmojis ?? DEFAULT_PARTICIPATION_EMOJIS);
  if (!decision) return { valid: false, passed: false, activity: false, decision: undefined };
  const activity = participationAllowed(decision, scenario.replyCooldown ?? false, scenario.reactionCooldown ?? false);
  return {
    valid: true, decision, activity,
    passed: scenario.expected.some(expected => isDeepStrictEqual(
      expected.action === "react" ? { ...expected, directed: Boolean(expected.directed) } : expected,
      decision.action === "react" ? { ...decision, directed: Boolean(decision.directed) } : decision,
    )) &&
      (scenario.expectedActivity === undefined || activity === scenario.expectedActivity),
  };
}
