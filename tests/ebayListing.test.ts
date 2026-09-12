import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import dns from "node:dns/promises";
import { chromium } from "playwright-core";
import { ebayListingUrl, fetchEbayListing } from "../src/utils/fetchEbayListing.js";
import { fetchWebpage } from "../src/utils/fetchWebpage.js";

const url = "https://www.ebay.com/itm/168671555854";
const html = '<title>Synology NAS | eBay</title><h1>Synology NAS</h1><p>US $910.00</p><p>3 bids</p><p>Ends in 1d 19h</p><a>Place bid</a><script type="application/ld+json">{"@type":"Product","offers":{"price":"910.0","priceCurrency":"USD"}}</script>';
type Reply = { status?: number; cookies?: boolean; location?: string; length?: number; streamedBytes?: number; body?: string };

function browserFixture(t: TestContext, replies: Reply[]) {
  const navigations: string[] = [], launches: any[] = [], contexts: any[] = [], calls: Array<{ method: string; args: any }> = [];
  let closed = 0, sequence = 0, sessionCookies = false;
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const cdp = new EventEmitter() as EventEmitter & { send: (method: string, args?: any) => Promise<any> };
  cdp.send = async (method, args) => {
    calls.push({ method, args });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    const request = pending.get(args?.requestId);
    if (request) {
      pending.delete(args.requestId);
      if (method === "Fetch.failRequest") request.reject(new Error("request blocked"));
      else request.resolve();
    }
  };
  const pause = (event: any) => new Promise<void>((resolve, reject) => {
    const requestId = String(++sequence);
    pending.set(requestId, { resolve, reject });
    cdp.emit("Fetch.requestPaused", { requestId, frameId: "main", resourceType: "Document", request: { url, method: "GET" }, ...event });
  });
  const context = {
    newCDPSession: async () => cdp,
    cookies: async () => sessionCookies ? [{ name: "anonymous", value: "private-to-context" }] : [],
    newPage: async () => ({ goto: async (target: string) => {
      navigations.push(target);
      const reply = replies.shift() ?? {};
      await pause({});
      await pause({ responseStatusCode: reply.status ?? 200, responseHeaders: [
        ...(reply.location ? [{ name: "Location", value: reply.location }] : []),
        ...(reply.length === undefined ? [] : [{ name: "Content-Length", value: String(reply.length) }]),
      ] });
      // Neither subresources nor embedded frames may reach their destinations.
      await assert.rejects(pause({ resourceType: "Image", request: { url: "http://127.0.0.1/private", method: "GET" } }));
      await assert.rejects(pause({ frameId: "child", request: { url, method: "GET" } }));
      sessionCookies ||= !!reply.cookies;
      cdp.emit("Network.dataReceived", { dataLength: reply.streamedBytes ?? Buffer.byteLength(reply.body ?? html) });
      if (closed) throw new Error("browser closed");
      return { status: () => reply.status ?? 200, body: async () => Buffer.from(reply.body ?? html), allHeaders: async () => ({ "content-type": "text/html; charset=utf-8" }) };
    } }),
  };
  const browser = {
    version: () => "152.0.0.0", newContext: async (options: any) => { contexts.push(options); sessionCookies = false; cdp.removeAllListeners(); return context; },
    close: async () => { closed++; for (const entry of pending.values()) entry.reject(new Error("browser closed")); pending.clear(); },
  };
  t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  t.mock.method(chromium, "launch", async (options: any) => { launches.push(options); closed = 0; return browser; });
  return { navigations, launches, contexts, calls, pause, browser, closed: () => closed };
}

test("only HTTPS eBay item URLs select the browser, with tracking removed", () => {
  for (const candidate of [url, url + "?tracking=value#x", "https://ebay.com/itm/a-listing-title/168671555854/"]) assert.equal(ebayListingUrl(candidate), url);
  for (const candidate of ["https://www.ebay.com/", "https://www.ebay.com/signin", "http://www.ebay.com/itm/168671555854", "https://www.ebay.com.evil.test/itm/168671555854", "https://user:password@www.ebay.com/itm/168671555854", "https://www.ebay.com:8443/itm/168671555854", "file:///etc/passwd"]) assert.equal(ebayListingUrl(candidate), undefined);
});

test("fetch_webpage recovers the anonymous session and returns auction facts without exposing cookies", async t => {
  const fixture = browserFixture(t, [{ status: 403, cookies: true }, {}, { status: 403, cookies: true }, {}]);
  for (let run = 0; run < 2; run++) {
    const result = await fetchWebpage(url);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.match(result.text, /US \$910\.00/);
      assert.match(result.text, /3 bids/);
      assert.match(result.text, /Ends in 1d 19h/);
      assert.equal(JSON.parse(result.structuredData[0]).offers.priceCurrency, "USD");
    }
    assert.doesNotMatch(JSON.stringify(result), /private-to-context/);
    assert.ok(fixture.closed());
  }
  assert.equal(fixture.navigations.length, 4);
  assert.equal(fixture.contexts.length, 2);
  for (const options of fixture.launches) {
    assert.equal(options.chromiumSandbox, true);
    assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH"]);
    assert.ok(options.args.includes("--host-resolver-rules=MAP www.ebay.com 8.8.8.8, MAP * ~NOTFOUND"));
  }
  for (const options of fixture.contexts) {
    assert.equal(options.javaScriptEnabled, false);
    assert.equal(options.serviceWorkers, "block");
    assert.equal(options.acceptDownloads, false);
    assert.equal(options.storageState, undefined);
  }
});

test("browser session setup is bounded to two navigations and requires source cookies", async t => {
  const fixture = browserFixture(t, [{ status: 403 }, { status: 403, cookies: true }, { status: 403, cookies: true }]);
  for (let run = 0; run < 2; run++) {
    const result = await fetchWebpage(url);
    assert.equal(result.status === "unavailable" && result.httpStatus, 403);
  }
  assert.equal(fixture.navigations.length, 3);
});

test("response interception stops redirects before private or alternate destinations are followed", async t => {
  const fixture = browserFixture(t, [{ status: 302, location: "http://169.254.169.254/latest/meta-data" }, { status: 307, location: "https://www.ebay.com/splashui/challenge" }]);
  for (let run = 0; run < 2; run++) {
    const result = await fetchWebpage(url);
    assert.equal(result.status === "unavailable" && result.errorCode, "http_error");
  }
  assert.deepEqual(fixture.navigations, [url, url]);
  assert.equal(fixture.calls.filter(call => call.method === "Fetch.failRequest").length, 2);
});

test("private DNS prevents browser startup", async t => {
  const fixture = browserFixture(t, []);
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  const result = await fetchWebpage(url);
  assert.equal(result.status === "unavailable" && result.errorCode, "policy_blocked");
  assert.equal(fixture.launches.length, 0);
});

test("declared and streamed body limits close the browser", async t => {
  const fixture = browserFixture(t, [{ length: 2048 }, { streamedBytes: 2048 }, { body: "x".repeat(2048), streamedBytes: 1 }]);
  for (let run = 0; run < 3; run++) {
    await assert.rejects(fetchEbayListing(url, { maxBytes: 1024 }), /1024-byte limit/);
    assert.ok(fixture.closed());
  }
});

test("cancellation during browser launch closes a late browser and never navigates", async t => {
  const fixture = browserFixture(t, []);
  const controller = new AbortController();
  let complete: (value: any) => void = () => {};
  let began: () => void = () => {};
  const started = new Promise<void>(resolve => { began = resolve; });
  t.mock.method(chromium, "launch", () => { began(); return new Promise(resolve => { complete = resolve; }); });
  const operation = fetchEbayListing(url, { maxBytes: 1024, signal: controller.signal });
  await started;
  controller.abort(new Error("owner cancelled"));
  await assert.rejects(operation, /owner cancelled/);
  complete(fixture.browser);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(fixture.closed());
  assert.equal(fixture.navigations.length, 0);
});
