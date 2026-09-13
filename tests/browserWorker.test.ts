import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserWorker, requireBrowserMemoryLimit } from "../src/browserWorker.js";
import { fetchBrowserResource } from "../src/utils/browserClient.js";
import { PublicFetchError } from "../src/utils/fetchArtifact.js";

const fixtureReader = (files: Record<string, string>) => (file: string) => {
  if (!(file in files)) throw new Error("ENOENT");
  return files[file];
};
const v2Root = {
  "/proc/self/cgroup": "0::/",
  "/proc/self/mountinfo": "29 23 0:26 / /sys/fs/cgroup ro - cgroup2 cgroup rw",
  "/sys/fs/cgroup/memory.max": "1073741824",
  "/sys/fs/cgroup/memory.swap.max": "0",
};
test("worker startup requires a hard memory plus swap bound", () => {
  assert.doesNotThrow(() => requireBrowserMemoryLimit(fixtureReader(v2Root)));
  for (const value of ["max", "9223372036854771712", "2147483648", "0"]) {
    assert.throws(() => requireBrowserMemoryLimit(fixtureReader({ ...v2Root, "/sys/fs/cgroup/memory.max": value })), /cgroup memory and swap limit/);
  }
  for (const value of ["max", "1", "1073741824"]) {
    assert.throws(() => requireBrowserMemoryLimit(fixtureReader({ ...v2Root, "/sys/fs/cgroup/memory.swap.max": value })), /cgroup memory and swap limit/);
  }
  const missing = { ...v2Root };
  delete (missing as Record<string, string>)["/sys/fs/cgroup/memory.swap.max"];
  assert.throws(() => requireBrowserMemoryLimit(fixtureReader(missing)), /cgroup memory and swap limit/);
});
test("host-namespace v1 uses the process path and ancestor combined memory/swap limits", () => {
  const files = {
    "/proc/self/cgroup": "7:cpu,cpuacct:/docker/worker\n6:memory:/docker/worker",
    "/proc/self/mountinfo": "29 23 0:26 / /sys/fs/cgroup/memory ro - cgroup cgroup rw,memory",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    "/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes": "9223372036854771712",
    "/sys/fs/cgroup/memory/docker/memory.limit_in_bytes": "1073741824",
    "/sys/fs/cgroup/memory/docker/memory.memsw.limit_in_bytes": "1073741824",
    "/sys/fs/cgroup/memory/docker/memory.use_hierarchy": "1",
    "/sys/fs/cgroup/memory/docker/worker/memory.limit_in_bytes": "9223372036854771712",
    "/sys/fs/cgroup/memory/docker/worker/memory.memsw.limit_in_bytes": "9223372036854771712",
  };
  assert.doesNotThrow(() => requireBrowserMemoryLimit(fixtureReader(files)));
  assert.throws(() => requireBrowserMemoryLimit(fixtureReader({ ...files, "/sys/fs/cgroup/memory/docker/memory.memsw.limit_in_bytes": "2147483648" })), /cgroup memory and swap limit/);
  assert.throws(() => requireBrowserMemoryLimit(fixtureReader({ ...files, "/sys/fs/cgroup/memory/docker/memory.use_hierarchy": "0" })), /cgroup memory and swap limit/);
});
test("v2 subtree mounts resolve membership and inherited memory/swap limits", () => {
  assert.doesNotThrow(() => requireBrowserMemoryLimit(fixtureReader({
    "/proc/self/cgroup": "0::/docker/worker/child",
    "/proc/self/mountinfo": "29 23 0:26 /docker/worker /sys/fs/cgroup ro - cgroup2 cgroup rw",
    "/sys/fs/cgroup/memory.max": "805306368",
    "/sys/fs/cgroup/memory.swap.max": "268435456",
    "/sys/fs/cgroup/child/memory.max": "max",
    "/sys/fs/cgroup/child/memory.swap.max": "max",
  })));
});

test("worker API preserves page results/errors and rejects oversized read budgets", async t => {
  let calls = 0;
  const read = async (url: string) => {
    calls++;
    if (url.endsWith("blocked")) throw new PublicFetchError("http_error", "The source returned HTTP 403.", 403);
    return { data: Buffer.from("<p>Public article</p>"), url, contentType: "text/html", filename: "page", charset: "utf-8" };
  };
  const server = createBrowserWorker({ general: read, ebay: read });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.AI_ASSISTANT_BROWSER_URL;
  process.env.AI_ASSISTANT_BROWSER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    if (previous === undefined) delete process.env.AI_ASSISTANT_BROWSER_URL; else process.env.AI_ASSISTANT_BROWSER_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const result = await fetchBrowserResource("general")("https://example.com", { maxBytes: 1024 });
  assert.equal(result.data.toString(), "<p>Public article</p>");
  await assert.rejects(fetchBrowserResource("ebay")("https://example.com/blocked", { maxBytes: 1024 }), (error: any) => error.code === "http_error" && error.status === 403);
  await assert.rejects(fetchBrowserResource("general")("https://example.com", { maxBytes: 16 * 1024 * 1024 }), /Invalid browser read request/);
  assert.equal(calls, 2);
});

test("browser reads never fall back to an unbounded in-process renderer", async t => {
  const previous = process.env.AI_ASSISTANT_BROWSER_URL;
  delete process.env.AI_ASSISTANT_BROWSER_URL;
  t.after(() => { if (previous !== undefined) process.env.AI_ASSISTANT_BROWSER_URL = previous; });
  await assert.rejects(fetchBrowserResource("general")("https://example.com", { maxBytes: 1024 }), /memory-limited browser worker/);
});
