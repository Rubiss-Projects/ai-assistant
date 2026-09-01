import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadFileAttachments, prepareDownloadedAttachments } from "../src/utils/downloadAttachments.js";

test("text attachment mode inlines non-images without exposing their path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-attachment-test-"));
  const path = join(directory, "example.ts");
  await writeFile(path, "console.log('untrusted');");

  try {
    const result = await prepareDownloadedAttachments([
      { filePath: path, displayName: "example.ts", contentType: "text/plain", isImage: false },
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
    { filePath: "/tmp/image.png", displayName: "image.png", contentType: "image/png", isImage: true },
  ], "text");

  assert.equal(result.textContext, "");
  assert.deepEqual(result.fileAttachments, [{ path: "/tmp/image.png", displayName: "image.png", kind: "image" }]);
});

test("invalid attachment modes fail closed", async () => {
  await assert.rejects(() => prepareDownloadedAttachments([], "execute"), /expected native or text/);
});

test("raster-wrapped inbound SVGs become native image inputs", async () => {
  const originalFetch = globalThis.fetch;
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${png.toString("base64")}"/></svg>`;
  globalThis.fetch = async () => new Response(svg, {
    status: 200,
    headers: { "content-type": "image/svg+xml", "content-length": String(Buffer.byteLength(svg)) },
  });
  try {
    const downloaded = await downloadFileAttachments([
      { url: "https://cdn.example/wrapped.svg", contentType: "image/svg+xml", name: "wrapped.svg" },
    ]);
    try {
      assert.equal(downloaded.attachments[0].isImage, true);
      assert.equal(downloaded.attachments[0].displayName, "wrapped.png");
      assert.match(downloaded.attachments[0].filePath!, /\.png$/);
      const prepared = await prepareDownloadedAttachments(downloaded.attachments, "native");
      assert.equal(prepared.fileAttachments[0].kind, "image");
    } finally {
      await downloaded.cleanup();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
