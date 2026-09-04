import assert from "node:assert/strict";
import test from "node:test";
import fs, { linkSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { decompressFrames, parseGIF } from "gifuct-js";
import gifenc from "gifenc";
import {
  captureAgentArtifacts,
  normalizeGifForDiscord,
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

test("explicit per-turn artifacts become in-memory attachments in an isolated retained directory", async () => {
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
  assert.equal(fs.existsSync(runDirectory), true);
  assert.equal(fs.readFileSync(join(runDirectory, "changes.patch"), "utf8"), "diff --git a/a b/a\n");
});

test("per-turn prompt names the isolated artifact directory", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  await captureAgentArtifacts(workspace, async (run) => {
    const prompt = withArtifactOutputPrompt("hello", run);
    assert.match(prompt, /hello[\s\S]*ai-assistant-artifacts[\\/][0-9a-f-]+/);
    return "done";
  });
});

test("single-raster SVG wrappers are uploaded with a Discord-previewable image name", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const response = await captureAgentArtifacts(workspace, async (run) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image width="1" height="1" href="data:image/png;base64,${png.toString("base64")}"/></svg>`;
    writeFileSync(join(run.directory, "generated.svg"), svg);
    return marker(workspace, run, "generated.svg");
  });

  assert.equal(response.attachments[0].displayName, "generated.png");
  assert.deepEqual(response.attachments[0].data, png);
});

test("real vector SVG artifacts remain downloadable without lossy normalization", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`;
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "vector.svg"), svg);
    return marker(workspace, run, "vector.svg");
  });

  assert.equal(response.attachments[0].displayName, "vector.svg");
  assert.equal(response.attachments[0].data.toString(), svg);
});

test("GIF artifacts are fully decoded and re-encoded before delivery", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const original = Buffer.from(
    "R0lGODlhAgABAPAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABBAgIACH5BAAUAAAALAAAAAACAAEAgP8AAAAA/wgFAAMACAgAOw==",
    "base64",
  );
  Buffer.from("ANIMEXTS1.0").copy(original, original.indexOf(Buffer.from("NETSCAPE2.0")));
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "animation.gif"), original);
    return marker(workspace, run, "animation.gif");
  });

  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "animation.gif");
  assert.equal(response.attachments[0].data.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.notDeepEqual(response.attachments[0].data, original);
  const normalized = parseGIF(new Uint8Array(response.attachments[0].data).buffer);
  const frames = decompressFrames(normalized, true);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((frame) => frame.delay), [100, 200]);
  const loopExtension = normalized.frames.find((frame) => "application" in frame);
  assert.ok(loopExtension && "application" in loopExtension);
  assert.deepEqual(Array.from(loopExtension.application.blocks.slice(0, 3)), [1, 0, 0]);
});

test("GIF bytes are normalized even when the artifact filename is mislabeled", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const original = Buffer.from(
    "R0lGODlhAgABAPAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABBAgIACH5BAAUAAAALAAAAAACAAEAgP8AAAAA/wgFAAMACAgAOw==",
    "base64",
  );
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "animation.png"), original);
    return marker(workspace, run, "animation.png");
  });

  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "animation.gif");
  assert.notDeepEqual(response.attachments[0].data, original);
});

test("fully opaque GIFs retain all 256 available color slots", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const palette = Array.from({ length: 256 }, (_value, index) => [
    (index & 0x1f) << 3,
    ((index >> 5) & 0x07) << 5,
    0,
  ]);
  const encoder = gifenc.GIFEncoder();
  encoder.writeFrame(Uint8Array.from({ length: 256 }, (_value, index) => index), 16, 16, { palette });
  encoder.finish();

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "opaque-256.gif"), encoder.bytes());
    return marker(workspace, run, "opaque-256.gif");
  });

  assert.equal(response.attachments.length, 1);
  const frame = decompressFrames(
    parseGIF(new Uint8Array(response.attachments[0].data).buffer),
    true,
  )[0];
  const colors = new Set<string>();
  for (let offset = 0; offset < frame.patch.length; offset += 4) {
    colors.add(Array.from(frame.patch.subarray(offset, offset + 3)).join(","));
  }
  assert.equal(colors.size, 256);
});

test("malformed GIF signatures are rejected under non-GIF filenames", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "broken.png"), Buffer.from("GIF89a-not-an-image"));
    return marker(workspace, run, "broken.png");
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /broken\.png.*could not be read safely/);
});

test("GIF normalization work is bounded across a whole response", () => {
  const original = Buffer.from(
    "R0lGODlhAgABAPAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABBAgIACH5BAAUAAAALAAAAAACAAEAgP8AAAAA/wgFAAMACAgAOw==",
    "base64",
  );
  const budget = { remainingPixels: 8 };

  normalizeGifForDiscord(original, "first.gif", 1_000_000, budget);
  assert.equal(budget.remainingPixels, 0);
  assert.throws(
    () => normalizeGifForDiscord(original, "second.gif", 1_000_000, budget),
    /response-wide animation work limit/,
  );
});

test("malformed GIF artifacts are rejected instead of reported as successful uploads", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "broken.gif"), Buffer.from("GIF89a-not-an-image"));
    return `Attached the GIF.\n\n${marker(workspace, run, "broken.gif")}`;
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /broken\.gif.*could not be decoded safely/);
  assert.match(response.content, /No attachment was produced/);
});

test("failed GIF parses consume the response-wide input byte budget", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  await withAttachmentLimits({ bytes: "100", totalBytes: "20" }, async () => {
    const response = await captureAgentArtifacts(workspace, async (run) => {
      const malformed = Buffer.from("GIF89a-not-an-image");
      writeFileSync(join(run.directory, "first.gif"), malformed);
      writeFileSync(join(run.directory, "second.gif"), malformed);
      return [marker(workspace, run, "first.gif"), marker(workspace, run, "second.gif")].join("\n");
    });

    assert.equal(response.attachments.length, 0);
    assert.match(response.content, /first\.gif.*could not be decoded safely/);
    assert.match(response.content, /second\.gif.*remaining 1-byte limit/);
  });
});

test("GIFs with truncated LZW image data are rejected before Discord upload", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const broken = Buffer.from(
    "R0lGODlhAQABAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIAQAAOw==",
    "base64",
  );
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "broken-lzw.gif"), broken);
    return marker(workspace, run, "broken-lzw.gif");
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /broken-lzw\.gif.*invalid LZW stream/);
});

test("GIF disposal method 2 restores the opaque logical background", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const original = Buffer.from(
    "R0lGODlhAgABAPEAAP8AAAAA/wD/AAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAgABAAAIBQADBAgIACH5BAgKAAAALAAAAAACAAEAgf8AAAAA/wD/AAAAAAgFAAMECAgAIfkEBQoAAgAsAAAAAAIAAQCB/wAAAAD/AP8AAAAACAUABQgICAA7",
    "base64",
  );
  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "disposal.gif"), original);
    return marker(workspace, run, "disposal.gif");
  });

  assert.equal(response.attachments.length, 1);
  const parsed = parseGIF(new Uint8Array(response.attachments[0].data).buffer);
  const frames = decompressFrames(parsed, true);
  assert.equal(frames.length, 3);
  assert.deepEqual(Array.from(frames[2].patch.subarray(0, 4)), [255, 0, 0, 255]);
});

test("GIF disposal method 2 uses the disposed frame's transparency", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const source = Buffer.from(
    "R0lGODlhAgABAPEAAP8AAAAA/wD/AAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAgABAAAIBQADBAgIACH5BAgKAAAALAAAAAACAAEAgf8AAAAA/wD/AAAAAAgFAAMECAgAIfkEBQoAAgAsAAAAAAIAAQCB/wAAAAD/AP8AAAAACAUABQgICAA7",
    "base64",
  );
  // Make frames two and three use the global palette, then mark frame two's
  // logical background index as transparent before its disposal-to-background.
  source[73] |= 0x01;
  source[87] = 0;
  source[125] = 0;
  const withoutThirdLocalPalette = Buffer.concat([source.subarray(0, 126), source.subarray(138)]);
  const globalFrames = Buffer.concat([
    withoutThirdLocalPalette.subarray(0, 88),
    withoutThirdLocalPalette.subarray(100),
  ]);

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "transparent-disposal.gif"), globalFrames);
    return marker(workspace, run, "transparent-disposal.gif");
  });

  assert.equal(response.attachments.length, 1);
  const frames = decompressFrames(
    parseGIF(new Uint8Array(response.attachments[0].data).buffer),
    true,
  );
  assert.equal(frames.length, 3);
  assert.equal(frames[0].transparentIndex, 0);
  assert.equal(frames[1].disposalType, 2);
  assert.equal(frames[2].patch[3], 0);
});

test("GIFs with only local color tables remain previewable", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const globalGif = Buffer.from(
    "R0lGODlhAQABAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAOw==",
    "base64",
  );
  const palette = globalGif.subarray(13, 19);
  const withoutGlobalPalette = Buffer.concat([globalGif.subarray(0, 13), globalGif.subarray(19)]);
  withoutGlobalPalette[10] &= 0x7f;
  const imageOffset = withoutGlobalPalette.indexOf(0x2c);
  withoutGlobalPalette[imageOffset + 9] = 0x80;
  const localGif = Buffer.concat([
    withoutGlobalPalette.subarray(0, imageOffset + 10),
    palette,
    withoutGlobalPalette.subarray(imageOffset + 10),
  ]);

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "local-palette.gif"), localGif);
    return marker(workspace, run, "local-palette.gif");
  });

  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "local-palette.gif");
  assert.equal(decompressFrames(
    parseGIF(new Uint8Array(response.attachments[0].data).buffer),
    true,
  ).length, 1);
});

test("GIF complexity is rejected before traversing oversized frame LZW data", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const oversized = Buffer.from(
    "R0lGODlhAQABAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAOw==",
    "base64",
  );
  oversized[6] = oversized[8] = 0x00;
  oversized[7] = oversized[9] = 0x20;
  const imageOffset = oversized.indexOf(0x2c);
  oversized[imageOffset + 5] = oversized[imageOffset + 7] = 0x00;
  oversized[imageOffset + 6] = oversized[imageOffset + 8] = 0x20;

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "oversized.gif"), oversized);
    return marker(workspace, run, "oversized.gif");
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /oversized\.gif.*complexity limit/);
});

test("GIF frame count is rejected before the full parser materializes every frame", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const header = Buffer.from("47494638396101000100800000000000ffffff", "hex");
  const onePixelFrame = Buffer.from("2c0000000001000100000202440100", "hex");
  const tooManyFrames = Buffer.concat([
    header,
    ...new Array(201).fill(onePixelFrame),
    Buffer.from([0x3b]),
  ]);

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "too-many-frames.gif"), tooManyFrames);
    return marker(workspace, run, "too-many-frames.gif");
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /too-many-frames\.gif.*complexity limit/);
});

test("GIF extension count is rejected before the full parser materializes every block", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const header = Buffer.from("47494638396101000100800000000000ffffff", "hex");
  const emptyComment = Buffer.from([0x21, 0xfe, 0x00]);
  const onePixelFrame = Buffer.from("2c0000000001000100000202440100", "hex");
  const tooManyExtensions = Buffer.concat([
    header,
    ...new Array(1_001).fill(emptyComment),
    onePixelFrame,
    Buffer.from([0x3b]),
  ]);

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "too-many-extensions.gif"), tooManyExtensions);
    return marker(workspace, run, "too-many-extensions.gif");
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /too-many-extensions\.gif.*structural complexity limit/);
});

test("first-frame local transparency does not erase an opaque global background", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const source = Buffer.from(
    "R0lGODlhAQABAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAOw==",
    "base64",
  );
  source.set([255, 0, 0, 0, 0, 255], 13);
  const graphicControlOffset = source.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
  source[graphicControlOffset + 3] |= 0x01;
  const imageOffset = source.indexOf(0x2c);
  source[imageOffset + 9] = 0x80;
  const withLocalPalette = Buffer.concat([
    source.subarray(0, imageOffset + 10),
    Buffer.from([0, 255, 0, 0, 0, 0]),
    source.subarray(imageOffset + 10),
  ]);

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "local-transparency.gif"), withLocalPalette);
    return marker(workspace, run, "local-transparency.gif");
  });

  assert.equal(response.attachments.length, 1);
  const normalized = decompressFrames(
    parseGIF(new Uint8Array(response.attachments[0].data).buffer),
    true,
  );
  assert.deepEqual(Array.from(normalized[0].patch.subarray(0, 4)), [255, 0, 0, 255]);
});

test("GIF LZW clear-code spam is rejected with bounded work", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const codes = [...new Array(2_000).fill(4), 0, 5];
  const packed = Buffer.alloc(Math.ceil(codes.length * 3 / 8));
  codes.forEach((code, index) => {
    const bit = index * 3;
    packed[Math.floor(bit / 8)] |= code << (bit % 8);
    if (bit % 8 > 5) packed[Math.floor(bit / 8) + 1] |= code >> (8 - (bit % 8));
  });
  const blocks: Buffer[] = [];
  for (let offset = 0; offset < packed.length; offset += 255) {
    const block = packed.subarray(offset, offset + 255);
    blocks.push(Buffer.from([block.length]), block);
  }
  const spam = Buffer.concat([
    Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002", "hex"),
    ...blocks,
    Buffer.from([0x00, 0x3b]),
  ]);

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "clear-spam.gif"), spam);
    return marker(workspace, run, "clear-spam.gif");
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /clear-spam\.gif.*invalid LZW stream/);
});

test("attachment success claims are corrected when no artifact was produced", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const response = await captureAgentArtifacts(workspace, async () => "Done — it is attached above.");
  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /No attachment was produced/);
});

test("provider-native artifacts use the shared secure attachment pipeline", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const providerRoot = mkdtempSync(join(tmpdir(), "provider-output-"));
  const generated = join(providerRoot, "generated.png");
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  writeFileSync(generated, png);

  const response = await captureAgentArtifacts(workspace, async () => ({
    content: "Generated image.",
    artifacts: [{ path: generated, trustedRoot: providerRoot }],
  }));

  assert.equal(response.content, "Generated image.");
  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "generated.png");
  assert.deepEqual(response.attachments[0].data, png);
});

test("provider-native artifacts take priority over invalid model markers", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const providerRoot = mkdtempSync(join(tmpdir(), "provider-output-"));
  const generated = join(providerRoot, "generated.png");
  writeFileSync(generated, Buffer.from("89504e470d0a1a0a00000000", "hex"));

  const response = await captureAgentArtifacts(workspace, async (run) => ({
    content: Array.from({ length: 10 }, (_value, index) => marker(workspace, run, `missing-${index}.png`)).join("\n"),
    artifacts: [{ path: generated, trustedRoot: providerRoot }],
  }));

  assert.deepEqual(response.attachments.map((attachment) => attachment.displayName), ["generated.png"]);
  assert.match(response.content, /only 10 attachments/);
});

test("provider-native artifacts cannot escape their declared trusted root", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const providerRoot = mkdtempSync(join(tmpdir(), "provider-output-"));
  const outside = join(tmpdir(), `outside-provider-${Date.now()}.png`);
  writeFileSync(outside, Buffer.from("89504e470d0a1a0a00000000", "hex"));

  const response = await captureAgentArtifacts(workspace, async () => ({
    content: "Generated image.",
    artifacts: [{ path: outside, trustedRoot: providerRoot }],
  }));

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /outside its trusted directory/);
});

test("a model artifact and provider-native copy with identical content are attached once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const providerRoot = mkdtempSync(join(tmpdir(), "provider-output-"));
  const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const providerImage = join(providerRoot, "generated.png");
  writeFileSync(providerImage, image);

  const response = await captureAgentArtifacts(workspace, async (run) => {
    writeFileSync(join(run.directory, "copied.png"), image);
    return {
      content: `Done.\n\n${marker(workspace, run, "copied.png")}`,
      artifacts: [{ path: providerImage, trustedRoot: providerRoot, displayName: "generated-image-1.png" }],
    };
  });

  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "generated-image-1.png");
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
  assert.match(response.content, /outside the allowed workspace|only regular files|could not be read safely/);
});

test("hard-linked workspace files cannot be exported as turn artifacts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-artifact-"));
  const privateFile = join(workspace, "private.txt");
  writeFileSync(privateFile, "private workspace data");
  const response = await captureAgentArtifacts(workspace, async (run) => {
    linkSync(privateFile, join(run.directory, "report.txt"));
    return marker(workspace, run, "report.txt");
  });

  assert.equal(response.attachments.length, 0);
  assert.match(response.content, /only regular files/);
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
        const name = index === 10 ? "excess-broken.gif" : `${index}.txt`;
        writeFileSync(join(run.directory, name), index === 10 ? "GIF89a-not-an-image" : String(index));
        markers.push(marker(workspace, run, name));
      }
      return markers.join("\n");
    });
    assert.equal(response.attachments.length, 10);
    assert.match(response.content, /only 10 attachments/);
    assert.doesNotMatch(response.content, /could not be decoded/);
  });
});
