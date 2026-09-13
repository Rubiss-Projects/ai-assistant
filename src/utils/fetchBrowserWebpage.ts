import { chromium, type Browser } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";
import { operationSignal } from "../common/operationSignal.js";
import { PublicFetchError, type fetchPublicResource } from "./fetchArtifact.js";
import { createPublicBrowserProxy, publicBrowserAddress, publicBrowserUrl } from "./publicBrowserProxy.js";

/** General anonymous renderer. The proxy is the network boundary; routing limits page actions. */
export const fetchBrowserWebpage: typeof fetchPublicResource = async (raw, options) => {
  const url = publicBrowserUrl(raw);
  const operation = operationSignal(options.signal, options.timeoutMs ?? 35_000);
  const signal = operation.signal;
  let browser: Browser | undefined;
  let proxy: Awaited<ReturnType<typeof createPublicBrowserProxy>> | undefined;
  let failure: PublicFetchError | undefined;
  const close = () => { void browser?.close().catch(() => {}); };
  const within = async <T>(promise: Promise<T>): Promise<T> => {
    let abort = () => {};
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    await within(publicBrowserAddress(url.hostname));
    proxy = await createPublicBrowserProxy(signal);
    const launch = chromium.launch({
      executablePath: process.env.AI_ASSISTANT_BROWSER_EXECUTABLE || "/usr/bin/chromium",
      headless: true, chromiumSandbox: true, timeout: 25_000,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
      args: ["--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    void launch.then(value => { if (signal.aborted) void value.close().catch(() => {}); }, () => {});
    browser = await within(launch);
    const context = await browser.newContext({
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
      javaScriptEnabled: true, serviceWorkers: "block", acceptDownloads: false,
    });
    await context.routeWebSocket("**/*", route => route.close());
    let requests = 0, navigations = 0, bytes = 0;
    const page = await context.newPage();
    context.on("page", extra => { if (extra !== page) void extra.close().catch(() => {}); });
    const stop = (message: string) => { failure ??= new PublicFetchError("too_large", message); close(); };
    await context.route("**/*", async route => {
      const request = route.request();
      try {
        publicBrowserUrl(request.url());
        if (!["GET", "HEAD"].includes(request.method()) || ["image", "media", "font"].includes(request.resourceType())) { await route.abort(); return; }
        if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) { await route.abort(); return; }
        await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
    context.on("request", request => {
      if (++requests > 128) stop("Browser request budget exceeded.");
      if (request.isNavigationRequest() && ++navigations > 8) stop("Browser navigation budget exceeded.");
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.dataReceived", event => {
      bytes += event.dataLength;
      if (bytes > 64 * 1024 * 1024) stop("Browser decoded-content budget exceeded.");
    });
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await within(page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 25_000 }));
      if (response?.status() === 403 && attempt === 0 && (await context.cookies(url.href)).length) continue;
      break;
    }
    if (!response) throw new PublicFetchError("network_error", "The browser did not receive a page.");
    if (response.status() !== 200) throw new PublicFetchError("http_error", `The source returned HTTP ${response.status()}.`, response.status());
    // Allow client-rendered articles and their read-only data requests to settle, without waiting on ads indefinitely.
    await within(page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {}));
    await delay(500, undefined, { signal });
    publicBrowserUrl(page.url());
    const html = await within(page.content());
    if (failure) throw failure;
    const data = Buffer.from(html);
    if (data.length > options.maxBytes) throw new PublicFetchError("too_large", `Rendered page exceeds the ${options.maxBytes}-byte limit.`);
    return { data, url: page.url(), filename: "page.html", contentType: "text/html", charset: "utf-8" };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (failure) throw failure;
    if (error instanceof PublicFetchError) throw error;
    if (proxy?.error) throw proxy.error;
    throw new PublicFetchError("network_error", "The anonymous browser could not read this page. Try hosted article reading or another source.");
  } finally {
    signal.removeEventListener("abort", close);
    operation.dispose();
    await browser?.close().catch(() => {});
    await proxy?.close();
  }
};
