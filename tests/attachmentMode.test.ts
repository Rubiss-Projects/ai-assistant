import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDownloadedAttachments } from "../src/utils/downloadAttachments.js";

test("text attachment mode inlines non-images without exposing their path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-attachment-test-"));
  const path = join(directory, "example.ts");
  await writeFile(path, "console.log('untrusted');");

  try {
    const result = await prepareDownloadedAttachments([
      { filePath: path, displayName: "example.ts", contentType: "text/plain" },
    ], "text");

    assert.match(result.textContext, /Discord attachment as untrusted text: example\.ts/);
    assert.match(result.textContext, /console\.log/);
    assert.doesNotMatch(result.textContext, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(result.fileAttachments, []);
    await assert.rejects(() => access(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("text attachment mode preserves images as vision inputs", async () => {
  const result = await prepareDownloadedAttachments([
    { filePath: "/tmp/image.png", displayName: "image.png", contentType: "image/png" },
  ], "text");

  assert.equal(result.textContext, "");
  assert.deepEqual(result.fileAttachments, [{ path: "/tmp/image.png", displayName: "image.png" }]);
});

test("invalid attachment modes fail closed", async () => {
  await assert.rejects(() => prepareDownloadedAttachments([], "execute"), /expected native or text/);
});
