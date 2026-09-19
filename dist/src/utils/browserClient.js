import { operationSignal } from "../common/operationSignal.js";
import { PublicFetchError } from "./fetchArtifact.js";
/** Operator-configured worker only; untrusted page URLs never select the control endpoint. */
export const fetchBrowserResource = (kind) => async (url, options) => {
    const configured = process.env.AI_ASSISTANT_BROWSER_URL?.trim();
    if (!configured)
        throw new PublicFetchError("unsupported", "Browser reading requires the memory-limited browser worker. Use hosted article reading or configure AI_ASSISTANT_BROWSER_URL.");
    const endpoint = new URL("/read", configured);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
        throw new PublicFetchError("unsupported", "Invalid browser worker configuration.");
    const operation = operationSignal(options.signal, options.timeoutMs ?? 40_000);
    try {
        const response = await fetch(endpoint, {
            method: "POST", redirect: "error", signal: operation.signal,
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, kind, maxBytes: options.maxBytes }),
        });
        if (!response.body)
            throw new Error("Missing response");
        const parts = [];
        let bytes = 0;
        for await (const part of response.body) {
            bytes += part.length;
            if (bytes > 12 * 1024 * 1024)
                throw new PublicFetchError("too_large", "Browser worker response exceeded its limit.");
            parts.push(Buffer.from(part));
        }
        const result = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (!response.ok || !result.ok)
            throw new PublicFetchError(result.code ?? "network_error", result.message ?? "Browser worker unavailable.", result.status, result.diagnostics);
        if (typeof result.data !== "string" || result.data.length > Math.ceil(options.maxBytes / 3) * 4 + 4 || typeof result.url !== "string" || typeof result.contentType !== "string")
            throw new Error("Invalid browser response");
        const data = Buffer.from(result.data, "base64");
        if (data.length > options.maxBytes)
            throw new PublicFetchError("too_large", "Browser document exceeded its limit.");
        return { data, url: result.url, contentType: result.contentType, charset: result.charset, filename: "page.html", diagnostics: result.diagnostics };
    }
    catch (error) {
        if (options.signal?.aborted)
            throw options.signal.reason;
        if (error instanceof PublicFetchError)
            throw error;
        throw new PublicFetchError("network_error", "The browser worker could not complete this read. Try hosted article reading or another source.");
    }
    finally {
        operation.dispose();
    }
};
