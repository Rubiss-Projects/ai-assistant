import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredSystemPrompt, providerSystemPrompt, withSystemPrompt } from "../src/common/systemPrompt.js";

function preserveEnvironment(run: () => void): void {
  const inline = process.env.AI_ASSISTANT_SYSTEM_PROMPT;
  const file = process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  try { run(); } finally {
    if (inline === undefined) delete process.env.AI_ASSISTANT_SYSTEM_PROMPT;
    else process.env.AI_ASSISTANT_SYSTEM_PROMPT = inline;
    if (file === undefined) delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
    else process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE = file;
  }
}

test("operator system prompt is optional while artifact instructions remain enabled", () => preserveEnvironment(() => {
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT;
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  assert.equal(configuredSystemPrompt(), undefined);
  assert.match(providerSystemPrompt(), /\[\[artifact:artifact-output\/path\/to\/file\]\]/);
  assert.match(withSystemPrompt("hello"), /artifact:[\s\S]*hello/);
}));

test("reads and trims an inline system prompt", () => preserveEnvironment(() => {
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "  Be cheerful.  ";
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  assert.equal(configuredSystemPrompt(), "Be cheerful.");
  assert.match(withSystemPrompt("hello"), /Be cheerful[\s\S]*hello/);
}));

test("system prompt file supports multiline text and takes precedence", () => preserveEnvironment(() => {
  const dir = mkdtempSync(join(tmpdir(), "ai-system-prompt-"));
  const file = join(dir, "prompt.txt");
  writeFileSync(file, "First line\nSecond line\n");
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "inline";
  process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE = file;
  assert.equal(configuredSystemPrompt(), "First line\nSecond line");
}));
