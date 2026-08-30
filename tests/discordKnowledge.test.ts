import assert from "node:assert/strict";
import test from "node:test";
import { classifyMemoryIntent } from "../src/utils/discordKnowledge.js";

test("classifies explicit conversational memory writes", () => {
  assert.equal(classifyMemoryIntent("Remember that Dave owes Sam cheese"), "save");
  assert.equal(classifyMemoryIntent("don't forget that Dave owes Sam cheese"), "save");
  assert.equal(classifyMemoryIntent("Could you remember that the trip is in June?"), "save");
  assert.equal(classifyMemoryIntent("keep this for later"), "save");
});

test("does not turn recall questions into memory writes", () => {
  assert.equal(classifyMemoryIntent("What do you remember about the beach plans?"), null);
  assert.equal(classifyMemoryIntent("Do you remember the cheese contract?"), null);
});

test("classifies explicit deletion separately from negated forget", () => {
  assert.equal(classifyMemoryIntent("Forget that cheese contract"), "forget");
  assert.equal(classifyMemoryIntent("Delete the memory about the beach trip"), "forget");
});
