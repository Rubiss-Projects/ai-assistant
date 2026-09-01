import assert from "node:assert/strict";
import test from "node:test";
import fs, { mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  captureAgentArtifacts,
  withArtifactOutputPrompt,
  type ArtifactRun,
} from "../src/common/agentResponse.js";

function withAttachmentLimits(
  values: { bytes?: string; count?: string; totalBytes?: string },
  run: () => Promise<void>,
): Promise<void> {
  const keys = [
    "AI_OUTPUT_ATTACHMENT_MAX_BYTES",
    "AI_OUTPUT_ATTACHMENT_MAX_COUNT",
    "AI_OUTPUT_ATTACHMENT_MAX_TOTAL_BYTES",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const configured = [values.bytes, values.count, values.totalBytes];
  for (let index = 0; index < keys.length; index++) {
    if (configured[index] === undefined) delete process.env[keys[index]];
    else process.env[keys[index]] = configured[index];
  }
  return run().finally(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

function marker(workspace: string, run: ArtifactRun, name: string): string {
  return `[[artifact:${relative(workspace, join(run.directory, name))}]]`;
}

test("explicit per-turn artifacts become in-memory attachments and are cleaned up", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  let runDirectory = "";
  const response = await captureAgentArtifacts(workspace, async (run) => {
    runDirectory = run.directory;
    writeFileSync(join(run.directory, "changes.patch"), "diff --git a/a b/a\n");
    return `Patch ready.\n\n${marker(workspace, run, "changes.patch")}`;
  });

  assert.equal(response.content, "Patch ready.");
  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "changes.patch");
  assert.equal(response.attachments[0].data.toString(), "diff --git a/a b/a\n");
  assert.equal(fs.existsSync(runDirectory), false);
});

test("per-turn prompt names the isolated artifact directory", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  await captureAgentArtifacts(workspace, async (run) => {
    const prompt = withArtifactOutputPrompt("hello", run);
    assert.match(prompt, /hello[\s\S]*ai-assistant-artifacts[\\/][0-9a-f-]+/);
    return "done";
  });
});

test("pre-existing workspace files and duplicate markers are not raw export authority", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  writeFileSync(join(workspace, "source.txt"), "private workspace data");
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "image.png"), "png");
    const imageMarker = marker(workspace, run, "image.png");
    return `[[artifact:source.txt]]\n${imageMarker}\n${imageMarker}`;
  });

  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "image.png");
  assert.match(response.content, /source\.txt.*outside this turn's artifact directory/);
});

test("outside, missing, oversized, and aggregate-overflow artifacts are rejected", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
  writeFileSync(outside, "secret");

  await withAttachmentLimits({ bytes: "5", totalBytes: "6" }, async () => {
    const response = await captureAgentArtifacts(workspace, async (run) => {
      writeFileSync(join(run.directory, "one.txt"), "1234");
      writeFileSync(join(run.directory, "two.txt"), "5678");
      writeFileSync(join(run.directory, "large.txt"), "123456");
      return [
        `[[artifact:${outside}]]`,
        marker(workspace, run, "missing.txt"),
        marker(workspace, run, "large.txt"),
        marker(workspace, run, "one.txt"),
        marker(workspace, run, "two.txt"),
      ].join("\n");
    });

    assert.deepEqual(response.attachments.map((item) => item.displayName), ["one.txt"]);
    assert.doesNotMatch(response.content, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(response.content, /outside.*artifact directory/);
    assert.match(response.content, /missing\.txt.*does not exist/);
    assert.match(response.content, /large\.txt.*5-byte limit/);
    assert.match(response.content, /two\.txt.*2-byte limit/);
  });
});

test("symbolic-link artifacts are rejected", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
  writeFileSync(outside, "secret");
  let unavailable: unknown;
  const response = await captureAgentArtifacts(workspace, async (run) => {
    try {
      symlinkSync(outside, join(run.directory, "link.txt"));
    } catch (error) {
      unavailable = error;
      return "done";
    }
    return marker(workspace, run, "link.txt");
  });
  if (unavailable) {
    context.skip(`symlinks unavailable: ${String(unavailable)}`);
    return;
  }
  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /only regular files|could not be read safely/);
});

test("a same-size file swap between validation and open is rejected", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const originalOpen = fs.promises.open;
  let swapped = false;
  try {
    const response = await captureAgentArtifacts(workspace, async (run) => {
      const target = join(run.directory, "report.txt");
      writeFileSync(target, "first");
      fs.promises.open = (async (filePath: fs.PathLike, flags: string | number) => {
        if (!swapped && String(filePath) === target) {
          swapped = true;
          renameSync(target, `${target}.original`);
          writeFileSync(target, "other");
        }
        return originalOpen(filePath, flags);
      }) as typeof fs.promises.open;
      return marker(workspace, run, "report.txt");
    });
    assert.equal(response.attachments.length, 0);
    assert.match(response.content, /changed while it was being opened/);
  } finally {
    fs.promises.open = originalOpen;
  }
});

test("attachment count is bounded to the Discord maximum", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  await withAttachmentLimits({ count: "999" }, async () => {
    const response = await captureAgentArtifacts(workspace, async (run) => {
      const markers: string[] = [];
      for (let index = 0; index < 11; index++) {
        const name = `${index}.txt`;
        writeFileSync(join(run.directory, name), String(index));
        markers.push(marker(workspace, run, name));
      }
      return markers.join("\n");
    });
    assert.equal(response.attachments.length, 10);
    assert.match(response.content, /only 10 attachments/);
  });
});
