import { Parser } from "htmlparser2";
import { setTimeout as delay } from "node:timers/promises";
import { operationSignal } from "../common/operationSignal.js";
import { fetchPublicResource, PublicFetchError } from "./fetchArtifact.js";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 24_000;
const MAX_STRUCTURED = 16_000;
export function lookupUrl(raw) {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Use a public HTTP(S) URL without credentials.");
    url.hash = "";
    return url.href;
}
/** Parse only: no scripts, subresources, cookies, or browser execution. */
export function extractWebpage(html) {
    let title = "", text = "", structuredBytes = 0, structured = "";
    let truncated = false;
    const structuredData = [];
    const stack = [];
    const separator = () => { if (text.length < MAX_TEXT)
        text += "\n"; };
    const parser = new Parser({
        onopentag(name, attributes) {
            const parent = stack.at(-1);
            stack.push({
                hidden: !!parent?.hidden || ["script", "style", "template", "svg", "noscript", "head"].includes(name)
                    || Object.hasOwn(attributes, "hidden") || attributes["aria-hidden"] === "true",
                title: name === "title",
                json: name === "script" && attributes.type?.toLowerCase() === "application/ld+json",
            });
            if (["p", "div", "br", "li", "tr", "h1", "h2", "h3"].includes(name))
                separator();
        },
        ontext(value) {
            const current = stack.at(-1);
            if (current?.title)
                title = (title + value).slice(0, 300);
            if (current?.json) {
                const remaining = Math.max(0, MAX_STRUCTURED - structuredBytes - structured.length);
                structured += value.slice(0, remaining);
                if (value.length > remaining)
                    truncated = true;
            }
            if (!current?.hidden && !current?.title) {
                const normalized = value.replace(/\s+/g, " ");
                const remaining = Math.max(0, MAX_TEXT - text.length);
                text += normalized.slice(0, remaining);
                if (normalized.length > remaining)
                    truncated = true;
            }
        },
        onclosetag() {
            if (stack.pop()?.json) {
                try {
                    JSON.parse(structured);
                    if (structuredData.length < 8) {
                        structuredData.push(structured);
                        structuredBytes += structured.length;
                    }
                    else
                        truncated = true;
                }
                catch { /* Ignore invalid or truncated JSON-LD. */ }
                structured = "";
            }
            separator();
        },
    }, { decodeEntities: true });
    parser.end(html);
    return { title: title.trim(), text: text.replace(/ *\n[\n ]*/g, "\n").trim(), structuredData, truncated };
}
export async function fetchWebpage(rawUrl, signal, fetchResource = fetchPublicResource) {
    const operation = operationSignal(signal, 25_000);
    const fetchedAt = () => new Date().toISOString();
    let url;
    try {
        url = lookupUrl(rawUrl);
    }
    catch {
        operation.dispose();
        return { status: "unavailable", url: "(invalid URL)", fetchedAt: fetchedAt(), errorCode: "policy_blocked", message: "Use a public HTTP(S) URL without credentials." };
    }
    try {
        let file;
        for (let attempt = 0; attempt < 2; attempt++) {
            operation.signal.throwIfAborted();
            try {
                file = await fetchResource(url, { signal: operation.signal, maxBytes: MAX_BYTES, standardPortsOnly: true });
                break;
            }
            catch (error) {
                // A single retry for transient transport/server failures. Never retry refusals or policy blocks.
                const transient = !(error instanceof PublicFetchError) || error.code === "network_error"
                    || (error.code === "http_error" && (error.status ?? 0) >= 500);
                if (attempt || !transient || operation.signal.aborted)
                    throw error;
                await delay(300, undefined, { signal: operation.signal });
            }
        }
        operation.signal.throwIfAborted();
        const resource = file;
        let page;
        if (["text/html", "application/xhtml+xml"].includes(resource.contentType))
            page = extractWebpage(resource.data.toString("utf8"));
        else if (["text/plain", "application/json"].includes(resource.contentType)) {
            const text = resource.data.toString("utf8");
            page = { title: "", text: text.slice(0, MAX_TEXT), structuredData: [], truncated: text.length > MAX_TEXT };
        }
        else
            throw new PublicFetchError("unsupported", "This URL did not return HTML, plain text, or JSON. Use fetch_artifact for files.");
        if (/^(?:pardon our interruption|just a moment|access denied|robot check|verify you are human|security check|checking your browser)\b/i.test(page.title)
            || (!page.structuredData.length && page.text.length < 1500 && /^(?:please )?(?:verify (?:that )?you are human|checking your browser|pardon our interruption)\b/i.test(page.text))) {
            return { status: "unavailable", url, fetchedAt: fetchedAt(), errorCode: "challenge", message: "The source returned a verification/challenge page; its content is unavailable." };
        }
        if (!page.text && !page.structuredData.length)
            return { status: "unavailable", url, fetchedAt: fetchedAt(), errorCode: "unreadable", message: "The page has no readable content; it may require JavaScript or authentication." };
        return { status: "available", url, finalUrl: resource.url, fetchedAt: fetchedAt(), ...page };
    }
    catch (error) {
        if (signal?.aborted)
            throw signal.reason ?? error;
        const code = operation.signal.aborted ? "timeout" : error instanceof PublicFetchError ? error.code : "network_error";
        return { status: "unavailable", url, fetchedAt: fetchedAt(), errorCode: code,
            message: code === "timeout" ? "The webpage request timed out." : error instanceof PublicFetchError ? error.message : "Could not connect to the public source.",
            ...(error instanceof PublicFetchError && error.status ? { httpStatus: error.status } : {}) };
    }
    finally {
        operation.dispose();
    }
}
