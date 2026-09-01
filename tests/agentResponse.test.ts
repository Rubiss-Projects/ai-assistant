import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgentResponse } from "../src/common/agentResponse.js";

function withAttachmentLimits(values: { bytes?: string; count?: string }, run: () => void): void {
  const previousBytes = process.env.AI_OUTPUT_ATTACHMENT_MAX_BYTES;
  const previousCount = process.env.AI_OUTPUT_ATTACHMENT_MAX_COUNT;
  try {
    if (values.bytes === undefined) delete process.env.AI_OUTPUT_ATTACHMENT_MAX_BYTES;
    else process.env.AI_OUTPUT_ATTACHMENT_MAX_BYTES = values.bytes;
    if (values.count === undefined) delete process.env.AI_OUTPUT_ATTACHMENT_MAX_COUNT;
    else process.env.AI_OUTPUT_ATTACHMENT_MAX_COUNT = values.count;
    run();
  } finally {
    if (previousBytes === undefined) delete process.env.AI_OUTPUT_ATTACHMENT_MAX_BYTES;
    else process.env.AI_OUTPUT_ATTACHMENT_MAX_BYTES = previousBytes;
    if (previousCount === undefined) delete process.env.AI_OUTPUT_ATTACHMENT_MAX_COUNT;
    else process.env.AI_OUTPUT_ATTACHMENT_MAX_COUNT = previousCount;
  }
}

test("explicit workspace artifact markers become in-memory attachments", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  mkdirSync(join(workspace, "output"));
  writeFileSync(join(workspace, "output", "changes.patch"), "diff --git a/a b/a\n");

  const response = prepareAgentResponse(
    "Patch ready.\n\n[[artifact:output/changes.patch]]",
    workspace,
  );

  assert.equal(response.content, "Patch ready.");
  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "changes.patch");
  assert.equal(response.attachments[0].data.toString(), "diff --git a/a b/a\n");
});

test("duplicate artifact markers attach a file once", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  writeFileSync(join(workspace, "image.png"), "png");

  const response = prepareAgentResponse(
    "[[artifact:image.png]]\n[[artifact:image.png]]",
    workspace,
  );

  assert.equal(response.content, "📎 Attached file(s).");
  assert.equal(response.attachments.length, 1);
});

test("outside, missing, and oversized artifacts are rejected without exposing paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
  writeFileSync(outside, "secret");
  writeFileSync(join(workspace, "large.txt"), "12345");

  withAttachmentLimits({ bytes: "4" }, () => {
    const response = prepareAgentResponse(
      `Files.\n[[artifact:${outside}]]\n[[artifact:missing.txt]]\n[[artifact:large.txt]]`,
      workspace,
    );

    assert.equal(response.attachments.length, 0);
    assert.doesNotMatch(response.content, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(response.content, /outside.*allowed workspace/);
    assert.match(response.content, /missing\.txt.*does not exist/);
    assert.match(response.content, /large\.txt.*4-byte limit/);
  });
});

test("symbolic-link artifacts are rejected", (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
  writeFileSync(outside, "secret");
  try {
    symlinkSync(outside, join(workspace, "link.txt"));
  } catch (error) {
    context.skip(`symlinks unavailable: ${String(error)}`);
    return;
  }

  const response = prepareAgentResponse("[[artifact:link.txt]]", workspace);
  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /outside the allowed workspace|only regular files/);
});

test("attachment count is bounded", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  writeFileSync(join(workspace, "one.txt"), "1");
  writeFileSync(join(workspace, "two.txt"), "2");

  withAttachmentLimits({ count: "1" }, () => {
    const response = prepareAgentResponse(
      "[[artifact:one.txt]]\n[[artifact:two.txt]]",
      workspace,
    );
    assert.equal(response.attachments.length, 1);
    assert.match(response.content, /only 1 attachments/);
  });
});
