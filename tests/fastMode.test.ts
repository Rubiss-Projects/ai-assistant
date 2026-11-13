import assert from "node:assert/strict";
import test from "node:test";
import { configuredCodexFastMode } from "../src/providers/codex.js";
import { slashCommandCapability } from "../src/common/accessPolicy.js";

test("fast mode validates its environment default", () => {
  const previous = process.env.CODEX_FAST_MODE;
  try {
    delete process.env.CODEX_FAST_MODE;
    assert.equal(configuredCodexFastMode(), false);
    process.env.CODEX_FAST_MODE = " TRUE ";
    assert.equal(configuredCodexFastMode(), true);
    process.env.CODEX_FAST_MODE = "false";
    assert.equal(configuredCodexFastMode(), false);
    process.env.CODEX_FAST_MODE = "yes";
    assert.throws(configuredCodexFastMode, /CODEX_FAST_MODE/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_FAST_MODE;
    else process.env.CODEX_FAST_MODE = previous;
  }
});

test("fast mode changes require session configuration access", () => {
  assert.equal(slashCommandCapability({ commandName: "fast", subcommand: "current" }), "chat.use");
  assert.equal(slashCommandCapability({ commandName: "fast", subcommand: "set" }), "session.configure");
});
