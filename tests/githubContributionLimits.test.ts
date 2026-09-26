import assert from "node:assert/strict";
import test from "node:test";
import { githubContributionLimits } from "../src/common/githubContributionLimits.js";

test("contribution limits default to 20 and accept only non-negative safe integers", () => {
  assert.deepEqual(githubContributionLimits({}), { publish: 20, reviews: 20 });
  for (const raw of ["", "   ", "20"]) {
    assert.deepEqual(githubContributionLimits({ GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT: raw, CODEX_REVIEW_LIMIT: raw }), { publish: 20, reviews: 20 });
  }
  assert.deepEqual(githubContributionLimits({ GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT: " 3 ", CODEX_REVIEW_LIMIT: "0" }), { publish: 3, reviews: null });
  assert.deepEqual(githubContributionLimits({ GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT: "0", CODEX_REVIEW_LIMIT: "7" }), { publish: null, reviews: 7 });
  for (const name of ["GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT", "CODEX_REVIEW_LIMIT"]) {
    for (const raw of ["-1", "1.5", "NaN", "Infinity", "unlimited", "1e2", "0x10", "9007199254740992"]) {
      assert.throws(() => githubContributionLimits({ [name]: raw }), new RegExp(`${name} must be a non-negative safe integer`));
    }
  }
});
