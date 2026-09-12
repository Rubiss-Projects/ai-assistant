import assert from "node:assert/strict";
import test from "node:test";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { extractWebpage, fetchWebpage } from "../src/utils/fetchWebpage.js";
import { PublicFetchError, type PublicResource } from "../src/utils/fetchArtifact.js";

const page = (html: string): PublicResource => ({ data: Buffer.from(html), contentType: "text/html", filename: "page", url: "https://example.com/page" });

test("large hidden subtrees cannot consume the visible text budget and inline prices stay intact", () => {
  for (const hidden of [`<svg>${"<path></path>".repeat(25_000)}</svg>`, `<template>${"<div>hidden</div>".repeat(25_000)}</template>`, `<div hidden>${"<div>hidden</div>".repeat(25_000)}</div>`]) {
    const result = extractWebpage(`<body>${hidden}<p>Price: $<span>4</span><span>2</span></p><p>3 bids</p></body>`);
    assert.equal(result.text, "Price: $42\n3 bids");
    assert.equal(result.truncated, false);
  }
});

test("webpage parsing decodes entities, retains JSON-LD and excludes scripts and hidden content", () => {
  const result = extractWebpage(`<html><head><title>Auction &amp; sale</title><script type="application/ld+json">{"offers":{"price":42}}</script><style>secret style</style></head><body><h1>Watch</h1><p>$42 &amp; 3 bids</p><script>secret code</script><div hidden>secret hidden<p>child</p></div><div aria-hidden="true">secret aria</div></body></html>`);
  assert.equal(result.title, "Auction & sale");
  assert.match(result.text, /\$42 & 3 bids/);
  assert.doesNotMatch(result.text, /secret|child|offers/);
  assert.deepEqual(JSON.parse(result.structuredData[0]), { offers: { price: 42 } });
  assert.equal(result.truncated, false);
  const huge = extractWebpage(`<p>${"x".repeat(30_000)}</p><script type="application/ld+json">${JSON.stringify({ text: "x".repeat(30_000) })}</script>`);
  assert.ok(huge.text.length <= 24_000 && huge.text.length > 23_000);
  assert.equal(huge.truncated, true);
  assert.deepEqual(huge.structuredData, []);
});

test("readable pages, challenge pages, empty JS shells and binary files have distinct outcomes", async () => {
  const available = await fetchWebpage("https://example.com/page#section", undefined, async () => page("<title>Watch</title><p>$42, 3 bids</p>"));
  assert.equal(available.status, "available");
  assert.equal(available.url, "https://example.com/page");
  for (const [html, expected] of [["<title>Just a moment...</title><p>Checking your browser</p>", "challenge"], ["<html><script>render()</script></html>", "unreadable"]]) {
    const result = await fetchWebpage("https://example.com", undefined, async () => page(html));
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") assert.equal(result.errorCode, expected);
  }
  const binary = await fetchWebpage("https://example.com", undefined, async () => ({ ...page("bytes"), contentType: "image/png" }));
  assert.equal(binary.status === "unavailable" && binary.errorCode, "unsupported");
});

test("transient server failures retry once, while HTTP refusals and policy blocks never retry", async () => {
  for (const [error, expected] of [[new PublicFetchError("http_error", "The source returned HTTP 403.", 403), 1], [new PublicFetchError("policy_blocked", "Private address"), 1], [new PublicFetchError("http_error", "HTTP 503", 503), 2]] as const) {
    let calls = 0;
    const result = await fetchWebpage("https://example.com", undefined, async () => { calls++; throw error; });
    assert.equal(calls, expected);
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") assert.equal(result.errorCode, error.code);
  }
  let calls = 0;
  const recovered = await fetchWebpage("https://example.com", undefined, async () => {
    if (++calls === 1) throw new Error("socket failed");
    return page("<p>Recovered</p>");
  });
  assert.equal(recovered.status, "available");
  assert.equal(calls, 2);
});

test("the reader rejects credential URLs and nonstandard ports before connecting, and pins DNS through redirects", async t => {
  let calls = 0;
  t.mock.method(dns, "lookup", async (hostname: string) => [{ address: hostname === "internal.test" ? "127.0.0.1" : "8.8.8.8", family: 4 }]);
  t.mock.method(https, "get", (url: URL, options: Record<string, any>, callback: (response: any) => void) => {
    calls++;
    assert.equal(url.hostname, "public.test");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    options.lookup(url.hostname, {}, (_error: unknown, address: string) => assert.equal(address, "8.8.8.8"));
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      response.statusCode = url.pathname === "/redirect" ? 302 : 200;
      response.headers = url.pathname === "/redirect" ? { location: "https://internal.test/private" } : { "content-type": "text/html" };
      callback(response);
      if (url.pathname !== "/redirect") response.end("<p>Public data</p>");
    });
    return request;
  });
  for (const url of ["https://user:secret@public.test", "https://public.test:8443", "https://internal.test", "file:///etc/passwd"]) {
    const result = await fetchWebpage(url);
    assert.equal(result.status === "unavailable" && result.errorCode, "policy_blocked");
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(calls, 0);
  assert.equal((await fetchWebpage("https://public.test")).status, "available");
  const redirected = await fetchWebpage("https://public.test/redirect");
  assert.equal(redirected.status === "unavailable" && redirected.errorCode, "policy_blocked");
  assert.equal(calls, 2);
});

test("cancellation aborts retrieval without a retry or an unavailable success result", async () => {
  const controller = new AbortController();
  let calls = 0;
  const operation = fetchWebpage("https://example.com", controller.signal, async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
  });
  controller.abort(new Error("cancelled by owner"));
  await assert.rejects(operation, /cancelled by owner/);
  assert.equal(calls, 1);
});
