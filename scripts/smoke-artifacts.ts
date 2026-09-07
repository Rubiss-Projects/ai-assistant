import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { captureAgentArtifacts } from "../src/common/agentResponse.js";
import { ArtifactToolSessions } from "../src/common/artifactToolBridge.js";

// Run inside the production image: no model credentials, Discord posts, or GPU required.
const workspace = await mkdtemp(path.join(os.tmpdir(), "artifact-smoke-"));
const sessions = new ArtifactToolSessions();
const client = new Client({ name: "artifact-smoke", version: "1" });
try {
  const input = path.join(workspace, "input.mp4");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12", "-t", "1",
    "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", input]);
  await client.connect(new StdioClientTransport({ ...(await sessions.config("smoke")), stderr: "inherit" }));
  assert.equal((await client.listTools()).tools.length, 3);
  const response = await captureAgentArtifacts(workspace, (run) => sessions.run("smoke", run, [{ path: input, binary: true, kind: "file" }], undefined, async (runtime, staged) => {
    const converted = await client.callTool({ name: "transcode_video", arguments: { run_id: runtime.id, path: staged[0].path, codec: "av1" } });
    assert.ok(!converted.isError, JSON.stringify(converted));
    const output = JSON.parse((converted.content as Array<{ text: string }>)[0].text) as { path: string };
    const codec = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", output.path], { encoding: "utf8" }).trim();
    assert.equal(codec, "av1");
    const registered = await client.callTool({ name: "attach_file", arguments: { run_id: runtime.id, path: output.path, filename: "converted.mp4" } });
    assert.ok(!registered.isError, JSON.stringify(registered));
    const bytes = await readFile(output.path);
    await writeFile(output.path, "changed");
    assert.deepEqual(run.registeredAttachments![0].data, bytes);
    return "Converted";
  }));
  assert.equal(response.attachments[0].displayName, "converted.mp4");
  assert.ok(response.attachments[0].data.length > 0);
  console.log("PASS: production MCP → H.264 input → software AV1 → validated frozen attachment");
} finally {
  await client.close();
  await sessions.shutdown();
  await rm(workspace, { recursive: true, force: true });
}
