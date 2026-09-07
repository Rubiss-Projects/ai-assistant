import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ArtifactTools } from "../src/common/artifactTools.js";
import { ArtifactToolSessions } from "../src/common/artifactToolBridge.js";
import { captureAgentArtifacts, createArtifactRun } from "../src/common/agentResponse.js";
import { codexClientOptions } from "../src/providers/codex.js";
import { openCodeChildEnvironment } from "../src/providers/opencode.js";
import { createCopilotPermissionHandler } from "../src/providers/copilot.js";

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "artifact-tools-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("registration freezes bytes, deduplicates retries, and overrides markers and discovery", async (t) => {
  const workspace = await fixture(t);
  const response = await captureAgentArtifacts(workspace, async (run) => {
    const runtime = new ArtifactTools(run);
    const output = path.join(run.directory, "final.txt");
    const intermediate = path.join(run.directory, "intermediate.txt");
    await writeFile(output, "final result");
    await writeFile(intermediate, "unwanted draft");
    const first = await runtime.call("attach_file", { run_id: runtime.id, path: output, filename: "report.txt" });
    assert.deepEqual(await runtime.call("attach_file", { run_id: runtime.id, path: output }), first);
    await writeFile(output, "changed after registration");
    await runtime.close();
    return { content: `Done\n[[artifact:${intermediate}]]`, fallbackArtifacts: [{ path: intermediate, trustedRoot: run.directory }] };
  });
  assert.equal(response.content, "Done");
  assert.equal(response.attachments.length, 1);
  assert.equal(response.attachments[0].displayName, "report.txt");
  assert.equal(response.attachments[0].data.toString(), "final result");
});

test("failed explicit registration prevents unrelated fallback delivery and permits a corrected retry", async (t) => {
  const workspace = await fixture(t);
  for (const fix of [false, true]) {
    const response = await captureAgentArtifacts(workspace, async (run) => {
      const runtime = new ArtifactTools(run);
      const output = path.join(run.directory, "output.txt");
      await assert.rejects(runtime.call("attach_file", { run_id: runtime.id, path: output }), /does not exist/);
      await writeFile(output, "result");
      if (fix) await runtime.call("attach_file", { run_id: runtime.id, path: output });
      await runtime.close();
      return { content: "Done", fallbackArtifacts: [{ path: output, trustedRoot: run.directory }] };
    });
    assert.equal(response.attachments.length, fix ? 1 : 0);
  }
});

test("tools reject other runs, hidden secrets, symlinks, hardlinks, and stale calls", async (t) => {
  const workspace = await fixture(t);
  const run = createArtifactRun(workspace);
  const runtime = new ArtifactTools(run);
  const other = createArtifactRun(workspace);
  const file = path.join(run.directory, "file.txt");
  await writeFile(file, "hello");
  await writeFile(path.join(other.directory, "file.txt"), "another response");
  await writeFile(path.join(workspace, ".env"), "secret");
  await assert.rejects(runtime.call("attach_file", { run_id: other.directory, path: file }), /expired/);
  await assert.rejects(runtime.call("attach_file", { run_id: runtime.id, path: path.join(other.directory, "file.txt") }), /another artifact run/);
  await assert.rejects(runtime.call("attach_file", { run_id: runtime.id, path: ".env" }));
  const shortcut = path.join(run.directory, "link.txt");
  await symlink(file, shortcut);
  await assert.rejects(runtime.call("attach_file", { run_id: runtime.id, path: shortcut }));
  await link(file, path.join(run.directory, "hard.txt"));
  await assert.rejects(runtime.call("attach_file", { run_id: runtime.id, path: file }), /regular files/);
  await runtime.close();
  await assert.rejects(runtime.call("fetch_artifact", { run_id: runtime.id, url: "https://example.com/file" }));
});

test("Discord resolution follows nested links, detects cycles, and returns selectable candidates", async (t) => {
  const workspace = await fixture(t);
  const first = "https://discord.com/channels/1/2/3";
  const second = "https://discord.com/channels/1/2/4";
  const lookups: string[] = [];
  const downloads: string[] = [];
  const runtime = new ArtifactTools(createArtifactRun(workspace), {
    resolveArtifactMessage: async (url) => {
      lookups.push(url);
      return { candidates: url === first ? [{ url: second }] : [
        { url: first }, { url: "https://example.com/video.mp4", name: "movie.mp4", sourceMessage: second },
        { url: "https://example.com/image.png", name: "image.png" },
      ] };
    },
  }, async (url) => { downloads.push(url); return { data: Buffer.from([0, 1, 255]), filename: "video.mp4", contentType: "video/mp4" }; });
  const result = await runtime.call("fetch_artifact", { run_id: runtime.id, url: first }) as { candidates: Array<{ candidate_id: string; name: string }> };
  assert.deepEqual(lookups, [first, second]);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(downloads, []);
  const selected = result.candidates.find((file) => file.name === "movie.mp4")!;
  const file = await runtime.call("fetch_artifact", { run_id: runtime.id, candidate_id: selected.candidate_id }) as { path: string; filename: string; source_message: string };
  assert.deepEqual(await readFile(file.path), Buffer.from([0, 1, 255]));
  assert.equal(file.filename, "movie.mp4");
  assert.equal(file.source_message, second);
  await runtime.call("fetch_artifact", { run_id: runtime.id, candidate_id: selected.candidate_id });
  assert.equal(downloads.length, 1);
  await runtime.close();
});

test("a single Discord attachment downloads immediately; cancellation revokes pending lookups", async (t) => {
  const workspace = await fixture(t);
  const run = createArtifactRun(workspace);
  const runtime = new ArtifactTools(run, { resolveArtifactMessage: async () => ({ candidates: [{ url: "https://example.com/a", name: "a.txt" }] }) },
    async () => ({ data: Buffer.from("hello"), filename: "a", contentType: "text/plain" }));
  const fetched = await runtime.call("fetch_artifact", { run_id: runtime.id, url: "https://discord.com/channels/1/2/3" }) as { path: string };
  assert.equal((await readFile(fetched.path)).toString(), "hello");
  await runtime.close();
  const hanging = new ArtifactTools(createArtifactRun(workspace), { resolveArtifactMessage: () => new Promise(() => {}) });
  const call = hanging.call("fetch_artifact", { run_id: hanging.id, url: "https://discord.com/channels/1/2/3" });
  const rejected = assert.rejects(call);
  await new Promise((resolve) => setImmediate(resolve));
  await hanging.close();
  await rejected;
});

test("real MCP stdio transport lists and calls tools, isolates sessions, and revokes completed runs", async (t) => {
  const workspace = await fixture(t);
  const sessions = new ArtifactToolSessions();
  t.after(() => sessions.shutdown());
  const config = await sessions.config("session-a");
  const client = new Client({ name: "artifact-test", version: "1" });
  await client.connect(new StdioClientTransport({ ...config, stderr: "pipe" }));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["fetch_artifact", "attach_file", "transcode_video"]);
  let runId: string;
  const response = await captureAgentArtifacts(workspace, (run) => sessions.run("session-a", run, [], undefined, async (runtime) => {
    runId = runtime.id;
    const file = path.join(run.directory, "hello.txt");
    await writeFile(file, "MCP delivered");
    const wrong = await sessions.config("session-b");
    const denied = await fetch(wrong.env.AI_ARTIFACT_BRIDGE_URL, { method: "POST", headers: { authorization: `Bearer ${wrong.env.AI_ARTIFACT_BRIDGE_TOKEN}` },
      body: JSON.stringify({ name: "attach_file", arguments: { run_id: runtime.id, path: file } }) });
    assert.equal((await denied.json()).isError, true);
    const result = await client.callTool({ name: "attach_file", arguments: { run_id: runtime.id, path: file } });
    assert.equal(result.isError, undefined);
    return "Here you go";
  }));
  assert.equal(response.attachments[0].data.toString(), "MCP delivered");
  assert.equal((await client.callTool({ name: "attach_file", arguments: { run_id: runId!, path: "hello.txt" } })).isError, true);
});

test("provider configuration enables only the host artifact bridge in shared mode", async (t) => {
  const workspace = await fixture(t);
  const previous = process.env.AI_ASSISTANT_SECURITY_MODE;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  t.after(() => { if (previous === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE; else process.env.AI_ASSISTANT_SECURITY_MODE = previous; });
  const config = { command: process.execPath, args: ["/trusted/artifactMcp.js"], env: { AI_ARTIFACT_BRIDGE_TOKEN: "test", AI_ARTIFACT_BRIDGE_URL: "http://127.0.0.1:123/call" } };
  const codex = codexClientOptions(workspace, config);
  assert.match(codex.configOverrides![0], /^mcp_servers=\{artifact_tools=/);
  assert.equal(codex.env?.AI_ARTIFACT_BRIDGE_TOKEN, undefined);
  const openCode = JSON.parse(openCodeChildEnvironment({ AI_ASSISTANT_SECURITY_MODE: "shared" }, config).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(openCode.mcp), ["artifact_tools"]);
  assert.equal(openCode.permission.bash, "deny");
  assert.equal(openCode.permission["artifact_tools_*"], "allow");
  const permission = createCopilotPermissionHandler(workspace);
  assert.equal((await permission({ kind: "mcp", serverName: "artifact_tools", readOnly: false } as never, {} as never)).kind, "approve-once");
  assert.equal((await permission({ kind: "mcp", serverName: "other", readOnly: false } as never, {} as never)).kind, "reject");
});

test("text mode accepts raster signatures with generic MIME types and rejects binary media", async (t) => {
  const workspace = await fixture(t);
  const previous = process.env.DISCORD_ATTACHMENT_MODE;
  process.env.DISCORD_ATTACHMENT_MODE = "text";
  t.after(() => { if (previous === undefined) delete process.env.DISCORD_ATTACHMENT_MODE; else process.env.DISCORD_ATTACHMENT_MODE = previous; });
  let data = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const runtime = new ArtifactTools(createArtifactRun(workspace), undefined,
    async () => ({ data, filename: "download.png", contentType: "application/octet-stream" }));
  const result = await runtime.call("fetch_artifact", { run_id: runtime.id, url: "https://example.com/raster" }) as { path: string };
  assert.deepEqual(await readFile(result.path), data);
  data = Buffer.from("not an image");
  await assert.rejects(runtime.call("fetch_artifact", { run_id: runtime.id, url: "https://example.com/binary" }), /raster images only/);
  await runtime.close();
});

test("registration accepts a delivery extension for unnamed downloads and preserves raster normalization", async (t) => {
  const workspace = await fixture(t);
  const run = createArtifactRun(workspace);
  const runtime = new ArtifactTools(run);
  const unnamed = path.join(run.directory, "download");
  await writeFile(unnamed, "report");
  const named = await runtime.call("attach_file", { run_id: runtime.id, path: unnamed, filename: "report.txt" }) as { filename: string };
  assert.equal(named.filename, "report.txt");
  const raster = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const wrapper = path.join(run.directory, "image.svg");
  await writeFile(wrapper, `<svg><image href="data:image/png;base64,${raster.toString("base64")}"/></svg>`);
  const image = await runtime.call("attach_file", { run_id: runtime.id, path: wrapper, filename: "picture.svg" }) as { filename: string };
  assert.equal(image.filename, "picture.png");
  await runtime.close();
});

test("run completion deletes staged/downloaded inputs but retains registered output copies", async (t) => {
  const workspace = await fixture(t);
  const original = path.join(workspace, "upload.txt");
  await writeFile(original, "original upload");
  const transients: string[] = [];
  let outputDirectory = "";
  const response = await captureAgentArtifacts(workspace, async (run) => {
    outputDirectory = run.directory;
    const runtime = new ArtifactTools(run, undefined, async () => ({ data: Buffer.from("download"), filename: "download.txt", contentType: "text/plain" }));
    transients.push((await runtime.stageInputs([{ path: original, kind: "file" }]))[0].path);
    const fetched = await runtime.call("fetch_artifact", { run_id: runtime.id, url: "https://example.com/file" }) as { path: string };
    transients.push(fetched.path);
    await runtime.call("attach_file", { run_id: runtime.id, path: fetched.path, filename: "result.txt" });
    return "Done";
  });
  for (const file of transients) await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal((await readFile(original)).toString(), "original upload");
  assert.equal(response.attachments[0].data.toString(), "download");
  const retained = await readdir(outputDirectory);
  assert.equal(retained.length, 1);
  assert.equal((await readFile(path.join(outputDirectory, retained[0]))).toString(), "download");
});

test("failed and cancelled runs clean inputs, and legacy markers are read before cleanup", async (t) => {
  const workspace = await fixture(t);
  for (const fail of [false, true]) {
    let transient = "";
    const response = captureAgentArtifacts(workspace, async (run) => {
      const runtime = new ArtifactTools(run, undefined, async () => ({ data: Buffer.from("legacy download"), filename: "download.txt", contentType: "text/plain" }));
      transient = (await runtime.call("fetch_artifact", { run_id: runtime.id, url: "https://example.com/file" }) as { path: string }).path;
      await runtime.cancel();
      if (fail) throw new Error("provider cancelled");
      return `Done\n[[artifact:${transient}]]`;
    });
    if (fail) await assert.rejects(response, /provider cancelled/);
    else assert.equal((await response).attachments[0].data.toString(), "legacy download");
    await assert.rejects(readFile(transient), { code: "ENOENT" });
  }
});

test("a fetched SVG wrapper keeps its normalized PNG extension when registered", async (t) => {
  const workspace = await fixture(t);
  const raster = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const svg = Buffer.from(`<svg><image href="data:image/png;base64,${raster.toString("base64")}"/></svg>`);
  const runtime = new ArtifactTools(createArtifactRun(workspace), undefined,
    async () => ({ data: svg, filename: "wrapped.svg", contentType: "image/svg+xml" }));
  const fetched = await runtime.call("fetch_artifact", { run_id: runtime.id, url: "https://example.com/wrapped.svg" }) as { path: string; filename: string };
  assert.equal(fetched.filename, "wrapped.png");
  const result = await runtime.call("attach_file", { run_id: runtime.id, path: fetched.path, filename: "picture.svg" }) as { filename: string };
  assert.equal(result.filename, "picture.png");
  assert.deepEqual(runtime.run.registeredAttachments![0].data, raster);
  await runtime.close();
});

test("cancellation during output copying removes the unregistered snapshot", async (t) => {
  const workspace = await fixture(t);
  const source = path.join(workspace, "output.txt");
  await writeFile(source, "cancelled output");
  const runtime = new ArtifactTools(createArtifactRun(workspace));
  const originalWrite = fs.writeFile;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    await originalWrite(...args);
    runtime.controller.abort();
  });
  await assert.rejects(runtime.call("attach_file", { run_id: runtime.id, path: source }), { name: "AbortError" });
  assert.deepEqual(runtime.run.registeredAttachments, []);
  await runtime.close();
  assert.deepEqual(await readdir(runtime.run.directory), []);
  assert.equal(await readFile(source, "utf8"), "cancelled output");
});
