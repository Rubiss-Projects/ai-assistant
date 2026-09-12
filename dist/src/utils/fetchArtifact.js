import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import ipaddr from "ipaddr.js";
import { operationSignal } from "../common/operationSignal.js";
export function inputByteLimit() {
    const value = Number(process.env.AI_INPUT_ATTACHMENT_MAX_BYTES ?? 100 * 1024 * 1024);
    if (!Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 * 1024) {
        throw new Error("AI_INPUT_ATTACHMENT_MAX_BYTES must be between 1 and 536870912.");
    }
    return value;
}
export function isPublicAddress(address) {
    try {
        const parsed = ipaddr.process(address);
        return parsed.range() === "unicast";
    }
    catch {
        return false;
    }
}
export function artifactFilename(value) {
    return path.basename(value.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download.bin";
}
export class PublicFetchError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
export function contentCharset(contentType) {
    const match = contentType.match(/;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i);
    return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim() || undefined;
}
export async function fetchPublicArtifact(rawUrl, signal) {
    const file = await fetchPublicResource(rawUrl, { signal, maxBytes: inputByteLimit() });
    if (file.contentType === "text/html" || /^\s*(?:<!doctype html|<html[\s>])/i.test(file.data.subarray(0, 512).toString())) {
        throw new Error("This URL returned a webpage, not a file. Use fetch_webpage for webpage content or a direct media/download URL for files.");
    }
    return { data: file.data, filename: file.filename, contentType: file.contentType };
}
/** DNS is validated AND pinned to the connection, including every redirect. */
export async function fetchPublicResource(rawUrl, options) {
    const operation = operationSignal(options.signal, options.timeoutMs ?? 30_000);
    const combined = operation.signal;
    try {
        const maxBytes = options.maxBytes;
        let url;
        try {
            url = new URL(rawUrl);
        }
        catch {
            throw new PublicFetchError("policy_blocked", "Provide a valid public HTTP(S) URL.");
        }
        for (let hop = 0; hop <= 5; hop++) {
            combined.throwIfAborted();
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
                throw new PublicFetchError("policy_blocked", "Only public HTTP(S) URLs without embedded credentials are supported.");
            }
            if (options.standardPortsOnly && url.port)
                throw new PublicFetchError("policy_blocked", "Webpages must use the standard HTTP(S) ports.");
            url.hash = "";
            const hostname = url.hostname.replace(/^\[|\]$/g, "");
            // Race DNS against the same deadline; the eventual DNS answer has no side effects.
            const addresses = await new Promise((resolve, reject) => {
                const abort = () => reject(new Error("Download cancelled or timed out."));
                combined.addEventListener("abort", abort, { once: true });
                dns.lookup(hostname, { all: true, verbatim: true }).then(resolve, reject)
                    .finally(() => combined.removeEventListener("abort", abort));
                if (combined.aborted)
                    abort();
            });
            if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
                throw new PublicFetchError("policy_blocked", "URLs must resolve only to public internet addresses.");
            }
            const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0];
            const result = await new Promise((resolve, reject) => {
                const request = (url.protocol === "https:" ? https : http).get(url, {
                    signal: combined,
                    agent: false,
                    // A fixed family disables Node's multi-address lookup contract. The
                    // callback below deliberately exposes only the validated, pinned address.
                    family: address.family,
                    headers: { "User-Agent": "ai-assistant-artifacts/1", "Accept-Encoding": "identity" },
                    lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
                }, (response) => {
                    const status = response.statusCode ?? 0;
                    if ([301, 302, 303, 307, 308].includes(status)) {
                        const redirect = response.headers.location;
                        response.destroy();
                        if (!redirect)
                            reject(new PublicFetchError("network_error", "Redirect has no destination."));
                        else
                            resolve({ redirect });
                        return;
                    }
                    if (status !== 200) {
                        response.destroy();
                        reject(new PublicFetchError("http_error", `The source returned HTTP ${status}.`, status));
                        return;
                    }
                    if (Number(response.headers["content-length"] ?? 0) > maxBytes) {
                        response.destroy();
                        reject(new PublicFetchError("too_large", `Input exceeds the ${maxBytes}-byte limit.`));
                        return;
                    }
                    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
                        response.destroy();
                        reject(new PublicFetchError("unsupported", "The source ignored the requested identity encoding."));
                        return;
                    }
                    const chunks = [];
                    let bytes = 0;
                    response.on("data", (chunk) => {
                        bytes += chunk.length;
                        if (bytes > maxBytes) {
                            response.destroy(new PublicFetchError("too_large", `Input exceeds the ${maxBytes}-byte limit.`));
                        }
                        else
                            chunks.push(chunk);
                    });
                    response.on("error", reject);
                    response.on("aborted", () => reject(new PublicFetchError("network_error", "The source closed the response before it completed.")));
                    response.on("end", () => {
                        const data = Buffer.concat(chunks);
                        const contentTypeHeader = response.headers["content-type"] ?? "application/octet-stream";
                        const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();
                        const disposition = response.headers["content-disposition"];
                        const name = disposition?.match(/filename="([^"]+)"/i)?.[1] ?? path.basename(url.pathname);
                        resolve({ file: { data, filename: artifactFilename(name), contentType, url: url.href, charset: contentCharset(contentTypeHeader) } });
                    });
                });
                request.on("error", reject);
            });
            if (result.file)
                return result.file;
            try {
                url = new URL(result.redirect, url);
            }
            catch {
                throw new PublicFetchError("policy_blocked", "The source returned an invalid redirect URL.");
            }
        }
        throw new PublicFetchError("policy_blocked", "Too many download redirects (maximum 5).");
    }
    finally {
        operation.dispose();
    }
}
