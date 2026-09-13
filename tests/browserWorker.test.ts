import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createBrowserWorker, requireBrowserMemoryLimit } from "../src/browserWorker.js";
import { fetchBrowserResource } from "../src/utils/browserClient.js";
import { PublicFetchError } from "../src/utils/fetchArtifact.js";

test("worker startup requires a hard cgroup bound", t => {
  for (const value of ["max", "9223372036854771712", "2147483648", "0"]) {
    t.mock.method(fs, "readFileSync", () => value);
    assert.throws(() => requireBrowserMemoryLimit(), /cgroup memory limit/);
  }
  t.mock.method(fs, "readFileSync", () => "1073741824");
  assert.doesNotThrow(() => requireBrowserMemoryLimit());
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
