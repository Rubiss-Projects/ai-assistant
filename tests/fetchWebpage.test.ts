import assert from "node:assert/strict";
import test from "node:test";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { decodeWebpage, extractWebpage, fetchWebpage } from "../src/utils/fetchWebpage.js";
import { PublicFetchError, type PublicResource } from "../src/utils/fetchArtifact.js";

const page = (html: string): PublicResource => ({ data: Buffer.from(html), contentType: "text/html", filename: "page", url: "https://example.com/page" });

test("source links honor the first active document base and ignore template bases", async () => {
  const result = await fetchWebpage("https://example.com/page", undefined, async () => page('<html><head><template><base href="https://wrong.test/"></template><base href="/news/"><base href="https://wrong.test/"></head><body><a href="story">Article</a></body></html>'));
  assert.equal(result.status, "available");
  if (result.status === "available") assert.deepEqual(result.links, ["https://example.com/news/story"]);
  assert.throws(() => extractWebpage("<div>".repeat(513)), /nesting limit/);
});

test("RSS and Atom provide linked entries and publication timestamps", async () => {
  for (const [contentType, xml] of [
    ["application/rss+xml", '<rss version="2.0"><channel><title>News</title><item><title>Panel update</title><link>https://example.com/news</link><pubDate>Sat, 12 Sep 2026 22:30:00 GMT</pubDate><description>&lt;p&gt;New details&lt;/p&gt;</description></item></channel></rss>'],
    ["application/atom+xml", '<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><entry><title>Panel update</title><link href="https://example.com/news"/><updated>2026-09-12T22:30:00Z</updated><summary>New details</summary></entry></feed>'],
  ]) {
    const result = await fetchWebpage("https://example.com/feed", undefined, async () => ({ ...page(xml), contentType }));
    assert.equal(result.status, "available");
    if (result.status === "available") { assert.match(result.text, /Panel update/); assert.match(result.text, /2026-09-12T22:30:00/); assert.ok(result.links?.includes("https://example.com/news")); }
  }
});

test("large news pages and continuation offsets retain article text beyond the first chunk", async () => {
  const html = `<!--${"x".repeat(3 * 1024 * 1024)}--><p>${"a".repeat(25_000)}</p><p>Final announcement</p><a href="/news">Read more</a>`;
  const read = async (_url: string, options: { maxBytes: number }) => { assert.ok(options.maxBytes > Buffer.byteLength(html)); return page(html); };
  const first = await fetchWebpage("https://example.com/page", undefined, read);
  assert.equal(first.status, "available");
  if (first.status !== "available") return;
  assert.equal(first.nextOffset, "24000");
  assert.ok(first.links?.includes("https://example.com/news"));
  const next = await fetchWebpage("https://example.com/page", undefined, read, { offset: Number(first.nextOffset) });
  assert.equal(next.status, "available");
  if (next.status === "available") { assert.match(next.text, /Final announcement/); assert.equal(next.nextOffset, undefined); }
});

test("generic browser fallback handles sparse script pages and refusals without retrying policy blocks", async () => {
  for (const response of [page('<title>News</title><script>render()</script><p>Loading</p>'), new PublicFetchError("http_error", "HTTP 403", 403)]) {
    let calls = 0;
    const result = await fetchWebpage("https://example.com/news", undefined, async () => { if (response instanceof Error) throw response; return response; }, {
      browserReader: async () => { calls++; return page("<article>Fresh rendered announcement</article>"); },
    });
    assert.equal(calls, 1);
    assert.equal(result.status === "available" && result.reader, "browser");
    assert.equal(result.status === "available" && result.text, "Fresh rendered announcement");
  }
  const result = await fetchWebpage("https://private.test", undefined, async () => { throw new PublicFetchError("policy_blocked", "Private DNS"); }, {
    browserReader: async () => { throw new Error("Must not run"); },
  });
  assert.equal(result.status === "unavailable" && result.errorCode, "policy_blocked");
});

test("inert structured data cannot supply facts or exhaust active JSON-LD budgets", () => {
  const stale = '<script type="application/ld+json">{"price":"stale"}</script>'.repeat(12);
  const oversized = `<script type="application/ld+json">${JSON.stringify({ stale: "x".repeat(30_000) })}</script>`;
  const inert = `<template>${stale}${oversized}<head>${stale}</head></template><svg>${stale}</svg><div hidden>${stale}</div><div aria-hidden="true">${stale}</div><noscript>${stale}</noscript>`;
  const result = extractWebpage(`<html><head><script type="application/ld+json">{"price":42}</script></head><body>${inert}<script type="application/ld+json">{"bids":3}</script><p>Current listing</p></body></html>`);
  assert.deepEqual(result.structuredData.map(value => JSON.parse(value)), [{ price: 42 }, { bids: 3 }]);
  assert.equal(result.text, "Current listing");
  assert.equal(result.truncated, false);
});

test("only the HTML document title participates in challenge detection", async () => {
  const hidden = "<svg><title>Access denied</title></svg><template><head><title>Robot check</title></head></template>";
  assert.equal(extractWebpage(`<html><head><title>Watch</title></head><body>${hidden}<p>$42</p></body></html>`).title, "Watch");
  assert.equal(extractWebpage(`<html><body>${hidden}<p>$42</p></body></html>`).title, "");
  const result = await fetchWebpage("https://example.com", undefined, async () => page(`${hidden}<p>$42</p>`));
  assert.equal(result.status, "available");
});

test("HTTP charset, HTML metadata, and Unicode BOMs preserve currency and names", () => {
  const latin = Buffer.from("<title>Caf\u00e9</title><p>\u00a342</p>", "latin1");
  const http = { ...page(""), data: latin, charset: "windows-1252" };
  assert.equal(extractWebpage(decodeWebpage(http)).text, "£42");
  assert.equal(extractWebpage(decodeWebpage(http)).title, "Café");
  for (const meta of ['<meta charset="windows-1252">', '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">']) {
    assert.equal(extractWebpage(decodeWebpage({ ...page(""), data: Buffer.concat([Buffer.from(meta), latin]) })).text, "£42");
  }
  assert.equal(decodeWebpage({ ...page(""), data: Buffer.from("<p>£42</p>", "utf16le"), charset: "utf-16le" }), "<p>£42</p>");
  const utf16 = Buffer.from("\ufeff<p>£42</p>", "utf16le");
  for (const data of [utf16, Buffer.from(utf16).swap16()]) {
    assert.equal(decodeWebpage({ ...page(""), data, charset: "windows-1252" }), "<p>£42</p>");
  }
  assert.throws(() => decodeWebpage({ ...http, charset: "not-a-real-charset" }), /character encoding/);
});

test("XHTML honors XML encoding declarations with HTTP and BOM precedence", async () => {
  const xml = '<?xml version="1.0" encoding="windows-1252"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Café</title></head><body><p>£42</p></body></html>';
  const resource = { ...page(""), data: Buffer.from(xml, "latin1"), contentType: "application/xhtml+xml" };
  const result = await fetchWebpage("https://example.com", undefined, async () => resource);
  assert.equal(result.status, "available");
  if (result.status === "available") { assert.equal(result.title, "Café"); assert.equal(result.text, "£42"); }
  assert.equal(decodeWebpage({ ...resource, data: Buffer.from(xml), charset: "utf-8" }), xml);
  assert.equal(decodeWebpage({ ...resource, data: Buffer.from("\ufeff" + xml, "utf16le"), charset: "utf-8" }), xml);
  const utf16xml = xml.replace("windows-1252", "UTF-16");
  for (const data of [Buffer.from(utf16xml, "utf16le"), Buffer.from(utf16xml, "utf16le").swap16()]) {
    assert.equal(decodeWebpage({ ...resource, data }), utf16xml);
  }
});

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
      response.headers = url.pathname === "/redirect" ? { location: "https://internal.test/private" } : { "content-type": "text/html; charset=windows-1252" };
      callback(response);
      if (url.pathname !== "/redirect") response.end(Buffer.from("<p>£42</p>", "latin1"));
    });
    return request;
  });
  for (const url of ["https://user:secret@public.test", "https://public.test:8443", "https://internal.test", "file:///etc/passwd"]) {
    const result = await fetchWebpage(url);
    assert.equal(result.status === "unavailable" && result.errorCode, "policy_blocked");
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(calls, 0);
  const publicPage = await fetchWebpage("https://public.test");
  assert.equal(publicPage.status, "available");
  if (publicPage.status === "available") assert.equal(publicPage.text, "£42");
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
