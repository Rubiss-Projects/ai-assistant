import assert from "node:assert/strict";
import test from "node:test";
import dns from "node:dns/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fetchPublicArtifact, isPublicAddress } from "../src/utils/fetchArtifact.js";

test("public address policy rejects loopback, private, link-local, mapped, and reserved networks", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1", "224.0.0.1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("downloader pins validated DNS, rejects private redirects, HTML, and streamed overflow", async (t) => {
  const previousLimit = process.env.AI_INPUT_ATTACHMENT_MAX_BYTES;
  process.env.AI_INPUT_ATTACHMENT_MAX_BYTES = "8";
  t.after(() => { if (previousLimit === undefined) delete process.env.AI_INPUT_ATTACHMENT_MAX_BYTES; else process.env.AI_INPUT_ATTACHMENT_MAX_BYTES = previousLimit; });
  t.mock.method(dns, "lookup", async (hostname: string) => [{ address: hostname === "internal.test" ? "127.0.0.1" : "8.8.8.8", family: 4 }]);
  const calls: string[] = [];
  t.mock.method(http, "get", (url: URL, options: Record<string, any>, callback: (response: any) => void) => {
    calls.push(url.hostname);
    assert.equal(options.family, 4);
    options.lookup(url.hostname, {}, (error: unknown, address: string, family: number) => {
      assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4);
    });
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      response.statusCode = url.pathname === "/redirect" ? 302 : 200;
      response.headers = url.pathname === "/redirect" ? { location: "http://internal.test/private" } : { "content-type": url.pathname === "/html" ? "text/html" : "video/mp4" };
      callback(response);
      if (url.pathname !== "/redirect") response.end(url.pathname === "/large" ? "123456789" : "1234");
    });
    return request;
  });
  const file = await fetchPublicArtifact("http://public.test/movie.mp4");
  assert.equal(file.filename, "movie.mp4");
  assert.equal(file.contentType, "video/mp4");
  assert.equal(file.data.toString(), "1234");
  await assert.rejects(fetchPublicArtifact("http://public.test/redirect"), /public internet/);
  assert.equal(calls.includes("internal.test"), false);
  await assert.rejects(fetchPublicArtifact("http://public.test/html"), /webpage/);
  await assert.rejects(fetchPublicArtifact("http://public.test/large"), /8-byte limit/);
  await assert.rejects(fetchPublicArtifact("file:///etc/passwd"), /HTTP/);
  await assert.rejects(fetchPublicArtifact("http://user:password@public.test/a"), /credentials/);
});
