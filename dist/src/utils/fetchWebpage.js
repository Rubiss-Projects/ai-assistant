import { Parser } from "htmlparser2";
import { setTimeout as delay } from "node:timers/promises";
import { operationSignal } from "../common/operationSignal.js";
import { contentCharset, fetchPublicResource, PublicFetchError } from "./fetchArtifact.js";
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
    let titleSeen = false;
    const stack = [];
    const blocks = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "ul", "ol", "table"]);
    const separator = () => { if (text.length && text.length < MAX_TEXT && !text.endsWith("\n"))
        text += "\n"; };
    const parser = new Parser({
        onopentag(name, attributes) {
            const parent = stack.at(-1);
            const titleElement = name === "title" && !titleSeen && (!parent || parent.titleScope);
            if (titleElement)
                titleSeen = true;
            const current = {
                name,
                hidden: !!parent?.hidden || ["script", "style", "template", "svg", "noscript", "head"].includes(name)
                    || Object.hasOwn(attributes, "hidden") || attributes["aria-hidden"] === "true",
                title: titleElement,
                titleScope: (name === "html" && !parent) || (name === "head" && (!parent || (parent.name === "html" && parent.titleScope))),
                json: name === "script" && attributes.type?.toLowerCase() === "application/ld+json",
                block: blocks.has(name),
            };
            stack.push(current);
            if (current.block && !current.hidden)
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
            const current = stack.pop();
            if (current?.json) {
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
            if (current?.block && !current.hidden)
                separator();
        },
    }, { decodeEntities: true });
    parser.end(html);
    return { title: title.trim(), text: text.replace(/ *\n[\n ]*/g, "\n").trim(), structuredData, truncated };
}
/** Prefer BOM, HTTP charset, then the document's declaration; never silently replace invalid bytes. */
export function decodeWebpage(resource) {
    const data = resource.data;
    let charset = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? "utf-8"
        : data[0] === 0xff && data[1] === 0xfe ? "utf-16le"
            : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : resource.charset;
    if (!charset && resource.contentType === "application/xhtml+xml") {
        // XML declarations precede the root element. UTF-16 signatures allow reading
        // declarations even when the response omits both the BOM and HTTP charset.
        charset = data.subarray(0, 4).equals(Buffer.from([0x00, 0x3c, 0x00, 0x3f])) ? "utf-16be"
            : data.subarray(0, 4).equals(Buffer.from([0x3c, 0x00, 0x3f, 0x00])) ? "utf-16le"
                : data.subarray(0, 1024).toString("latin1").match(/^<\?xml\s+[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/i)?.[2];
    }
    if (!charset && resource.contentType === "text/html") {
        const sniff = new Parser({ onopentag(name, attributes) {
                if (name !== "meta" || charset)
                    return;
                charset = attributes.charset?.trim() || (attributes["http-equiv"]?.toLowerCase() === "content-type"
                    ? contentCharset(attributes.content ?? "") : undefined);
                // HTML metadata cannot select UTF-16 without a BOM; those labels imply UTF-8.
                if (/^utf-16(?:le|be)?$/i.test(charset ?? ""))
                    charset = "utf-8";
            } });
        sniff.end(data.subarray(0, 1024).toString("latin1"));
    }
    try {
        return new TextDecoder(charset || "utf-8", { fatal: true }).decode(data);
    }
    catch {
        throw new PublicFetchError("unsupported", "The page could not be decoded using its declared character encoding (or UTF-8 when none is declared).");
    }
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
            page = extractWebpage(decodeWebpage(resource));
        else if (["text/plain", "application/json"].includes(resource.contentType)) {
            const text = decodeWebpage(resource);
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
