import dns from "node:dns/promises";
import { chromium, type Browser } from "playwright-core";
import { operationSignal } from "../common/operationSignal.js";
import { contentCharset, isPublicAddress, PublicFetchError, type fetchPublicResource, type PublicResource } from "./fetchArtifact.js";
import { acquireBrowserSlot, closeBrowserAndRelease } from "./browserBudget.js";

/** Only canonical, public eBay item pages can use the browser transport. */
export function ebayListingUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== "https:" || url.port || url.username || url.password || !["www.ebay.com", "ebay.com"].includes(url.hostname)) return;
  const item = url.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/)?.[1];
  return item ? `https://www.ebay.com/itm/${item}` : undefined;
}

/** Fresh anonymous Chromium session; no scripts, subresources, actions, or redirects. */
export const fetchEbayListing: typeof fetchPublicResource = async (raw, options): Promise<PublicResource> => {
  const url = ebayListingUrl(raw);
  if (!url) throw new PublicFetchError("policy_blocked", "The eBay reader only accepts public HTTPS item URLs.");
  const operation = operationSignal(options.signal, options.timeoutMs ?? 25_000);
  const signal = operation.signal;
  let browser: Browser | undefined;
  let launch: Promise<Browser> | undefined;
  let releaseBrowser: (() => void) | undefined;
  let failure: Error | undefined;
  const close = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener("abort", close, { once: true });
  const within = async <T>(promise: Promise<T>): Promise<T> => {
    let abort: () => void = () => {};
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  };
  try {
    signal.throwIfAborted();
    const addresses = await within(dns.lookup("www.ebay.com", { all: true, verbatim: true }));
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new PublicFetchError("policy_blocked", "eBay must resolve only to public internet addresses.");
    const address = addresses.find(item => item.family === 4) ?? addresses[0];
    const pinned = address.family === 6 ? `[${address.address}]` : address.address;
    releaseBrowser = await acquireBrowserSlot(signal);
    signal.throwIfAborted();
    launch = chromium.launch({
      executablePath: process.env.AI_ASSISTANT_BROWSER_EXECUTABLE || "/usr/bin/chromium",
      headless: true, chromiumSandbox: true, timeout: 25_000,
      // Do not inherit bot credentials or proxy/account configuration.
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
      args: [`--host-resolver-rules=MAP www.ebay.com ${pinned}, MAP * ~NOTFOUND`, "--disable-quic", "--no-proxy-server"],
    });
    browser = await within(launch);
    signal.throwIfAborted();
    const context = await browser.newContext({
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
      javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const frameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    let bytes = 0;
    let navigationPermitted = false;
    const stop = (error: Error) => { failure ??= error; close(); };
    cdp.on("Network.dataReceived", event => {
      bytes += event.dataLength;
      if (bytes > options.maxBytes) stop(new PublicFetchError("too_large", `Input exceeds the ${options.maxBytes}-byte limit.`));
    });
    cdp.on("Fetch.requestPaused", event => {
      void (async () => {
        const allowed = event.frameId === frameId && event.resourceType === "Document" && event.request.method === "GET" && event.request.url === url;
        if (!allowed) {
          if (event.frameId === frameId && event.resourceType === "Document") failure ??= new PublicFetchError("policy_blocked", "eBay navigated away from the requested listing.");
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
        } else if (event.responseStatusCode !== undefined) {
          // Intercept responses before Chromium follows any Location header.
          if (event.responseStatusCode >= 300 && event.responseStatusCode < 400) {
            failure ??= new PublicFetchError("http_error", "eBay redirected away from the requested listing.", event.responseStatusCode);
            await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
          } else {
            const length = event.responseHeaders?.find(header => header.name.toLowerCase() === "content-length")?.value;
            if (Number(length) > options.maxBytes) stop(new PublicFetchError("too_large", `Input exceeds the ${options.maxBytes}-byte limit.`));
            else await cdp.send("Fetch.continueResponse", { requestId: event.requestId });
          }
        } else if (!navigationPermitted) {
          failure ??= new PublicFetchError("policy_blocked", "eBay attempted an unrequested page navigation.");
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
        } else {
          navigationPermitted = false;
          await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
        }
      })().catch(error => { if (!signal.aborted && !failure) stop(error); });
    });
    await cdp.send("Network.enable");
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      navigationPermitted = true;
      const response = await within(page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 }));
      if (!response) throw new PublicFetchError("network_error", "eBay did not return a listing response.");
      const data = await within(response.body());
      if (failure) throw failure;
      if (data.length > options.maxBytes) throw new PublicFetchError("too_large", `Input exceeds the ${options.maxBytes}-byte limit.`);
      // eBay's first response may establish an anonymous session with HTTP 403.
      // Retain only this fresh context's cookies for one read of the same item.
      if (response.status() === 403 && attempt === 0 && (await context.cookies(url)).length) continue;
      if (response.status() !== 200) throw new PublicFetchError("http_error", `The source returned HTTP ${response.status()}.`, response.status());
      const header = (await response.allHeaders())["content-type"] ?? "application/octet-stream";
      return { data, url, filename: "listing.html", contentType: header.split(";")[0].trim().toLowerCase(), charset: contentCharset(header) };
    }
    throw new PublicFetchError("http_error", "The source returned HTTP 403.", 403);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (failure) throw failure;
    if (error instanceof PublicFetchError) throw error;
    throw new PublicFetchError("unsupported", "The eBay browser reader could not complete. Chromium and its sandbox must be available.");
  } finally {
    signal.removeEventListener("abort", close);
    operation.dispose();
    await closeBrowserAndRelease(browser, launch, releaseBrowser);
  }
};
