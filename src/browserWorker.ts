import http from "node:http";
import { pathToFileURL } from "node:url";
import { fetchBrowserWebpage } from "./utils/fetchBrowserWebpage.js";
import { fetchEbayListing } from "./utils/fetchEbayListing.js";
import { PublicFetchError, type fetchPublicResource } from "./utils/fetchArtifact.js";
import { requireBrowserMemoryLimit } from "./utils/browserMemory.js";
export { requireBrowserMemoryLimit } from "./utils/browserMemory.js";

/** Control API belongs on a private network shared only with the bot; never publish its port. */
export function createBrowserWorker(readers: { general: typeof fetchPublicResource; ebay: typeof fetchPublicResource } = { general: fetchBrowserWebpage, ebay: fetchEbayListing }) {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") { response.end("ok"); return; }
    if (request.method !== "POST" || request.url !== "/read") { response.writeHead(404); response.end(); return; }
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        if (bytes > 16_384) throw new PublicFetchError("too_large", "Browser request is too large.");
        parts.push(Buffer.from(part));
      }
      const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (typeof input.url !== "string" || input.url.length > 8192 || !["general", "ebay"].includes(input.kind) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 8 * 1024 * 1024) throw new PublicFetchError("policy_blocked", "Invalid browser read request.");
      const resource = await readers[input.kind as "general" | "ebay"](input.url, { signal: controller.signal, maxBytes: input.maxBytes, timeoutMs: 35_000, standardPortsOnly: true });
      if (response.destroyed) return;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, data: resource.data.toString("base64"), url: resource.url, contentType: resource.contentType, charset: resource.charset }));
    } catch (error) {
      if (response.destroyed) return;
      response.writeHead(422, { "Content-Type": "application/json" });
      response.end(JSON.stringify(error instanceof PublicFetchError
        ? { ok: false, code: error.code, message: error.message, status: error.status }
        : { ok: false, code: "network_error", message: "The browser worker could not complete this read." }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireBrowserMemoryLimit();
  const server = createBrowserWorker();
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 40;
  server.listen(Number(process.env.BROWSER_WORKER_PORT || 3123), process.env.BROWSER_WORKER_BIND || "0.0.0.0", () => console.log("Memory-limited public browser worker ready."));
}
