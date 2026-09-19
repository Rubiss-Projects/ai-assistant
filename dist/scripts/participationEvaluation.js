import { isDeepStrictEqual } from "node:util";
import { DEFAULT_PARTICIPATION_EMOJIS, participationAllowed, validateParticipationDecision } from "../src/common/chatParticipation.js";
export function assessParticipation(raw, scenario) {
    const ids = scenario.candidateIds ?? [scenario.messages.at(-1).id];
    const decision = validateParticipationDecision(raw, ids, scenario.availableEmojis ?? DEFAULT_PARTICIPATION_EMOJIS);
    if (!decision)
        return { valid: false, passed: false, activity: false, decision: undefined };
    const activity = participationAllowed(decision, scenario.replyCooldown ?? false, scenario.reactionCooldown ?? false);
    return {
        valid: true, decision, activity,
        passed: scenario.expected.some(expected => isDeepStrictEqual(expected, decision)) &&
            (scenario.expectedActivity === undefined || activity === scenario.expectedActivity),
    };
}
