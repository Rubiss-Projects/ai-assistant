import { Parser, parseFeed } from "htmlparser2";
import { setTimeout as delay } from "node:timers/promises";
import { operationSignal } from "../common/operationSignal.js";
import { contentCharset, fetchPublicResource, PublicFetchError, type PublicResource } from "./fetchArtifact.js";
import { ebayListingUrl } from "./fetchEbayListing.js";
import { fetchBrowserResource } from "./browserClient.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 24_000;
const MAX_DOCUMENT_TEXT = 192_000;
const MAX_STRUCTURED = 16_000;

export interface LookupRecord {
  url: string;
  checkedAt: string;
  status: "fetched" | "verified" | "unavailable";
  summary?: string;
  errorCode?: string;
}

export type WebpageResult = {
  status: "available"; url: string; finalUrl: string; fetchedAt: string;
  title: string; text: string; structuredData: string[]; truncated: boolean;
  links?: string[]; nextOffset?: string; reader?: "http" | "browser";
} | {
  status: "unavailable"; url: string; fetchedAt: string;
  errorCode: string; message: string; httpStatus?: number;
};

export function lookupUrl(raw: string): string {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use a public HTTP(S) URL without credentials.");
  url.hash = "";
  return url.href;
}

/** Parse only: no scripts, subresources, cookies, or browser execution. */
export function extractWebpage(html: string, maxText = MAX_TEXT) {
  let title = "", text = "", structuredBytes = 0, structured = "";
  let truncated = false;
  const structuredData: string[] = [];
  const links: string[] = [];
  let baseHref: string | undefined;
  let titleSeen = false;
  const stack: Array<{ name: string; hidden: boolean; inert: boolean; baseInert: boolean; title: boolean; json: boolean; block: boolean; titleScope: boolean }> = [];
  const blocks = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "ul", "ol", "table"]);
  const separator = () => { if (text.length && text.length < maxText && !text.endsWith("\n")) text += "\n"; };
  const parser = new Parser({
    onopentag(name, attributes) {
      if (stack.length >= 512) throw new PublicFetchError("too_large", "The page exceeds the HTML nesting limit.");
      const parent = stack.at(-1);
      // Head text is invisible, but its metadata is active. Templates, foreign
      // SVG content and explicitly hidden subtrees must not supply lookup facts.
      const inert = !!parent?.inert || ["template", "svg", "noscript", "style"].includes(name)
        || Object.hasOwn(attributes, "hidden") || attributes["aria-hidden"] === "true";
      const titleElement = name === "title" && !inert && !titleSeen && (!parent || parent.titleScope);
      if (titleElement) titleSeen = true;
      const current = {
        name,
        hidden: inert || !!parent?.hidden || ["script", "head"].includes(name),
        inert,
        baseInert: !!parent?.baseInert || ["template", "svg", "noscript"].includes(name),
        title: titleElement,
        titleScope: (name === "html" && !parent) || (name === "head" && (!parent || (parent.name === "html" && parent.titleScope))),
        json: name === "script" && !inert && attributes.type?.toLowerCase() === "application/ld+json",
        block: blocks.has(name),
      };
      stack.push(current);
      if (name === "base" && !current.baseInert && baseHref === undefined && attributes.href !== undefined) baseHref = attributes.href;
      // Web components also expose article destinations through href attributes.
      if (!current.hidden && attributes.href && links.length < 120) links.push(attributes.href);
      if (current.block && !current.hidden) separator();
    },
    ontext(value) {
      const current = stack.at(-1);
      if (current?.title) title = (title + value).slice(0, 300);
      if (current?.json) {
        const remaining = Math.max(0, MAX_STRUCTURED - structuredBytes - structured.length);
        structured += value.slice(0, remaining);
        if (value.length > remaining) truncated = true;
      }
      if (!current?.hidden && !current?.title) {
        const normalized = value.replace(/\s+/g, " ");
        const remaining = Math.max(0, maxText - text.length);
        text += normalized.slice(0, remaining);
        if (normalized.length > remaining) truncated = true;
      }
    },
    onclosetag() {
      const current = stack.pop();
      if (current?.json) {
        try {
          JSON.parse(structured);
          if (structuredData.length < 8) { structuredData.push(structured); structuredBytes += structured.length; }
          else truncated = true;
        } catch { /* Ignore invalid or truncated JSON-LD. */ }
        structured = "";
      }
      if (current?.block && !current.hidden) separator();
    },
  }, { decodeEntities: true });
  parser.end(html);
  return { title: title.trim(), text: text.replace(/ *\n[\n ]*/g, "\n").trim(), structuredData, truncated, links, baseHref };
}

/** Prefer BOM, HTTP charset, then the document's declaration; never silently replace invalid bytes. */
export function decodeWebpage(resource: PublicResource): string {
  const data = resource.data;
  let charset = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? "utf-8"
    : data[0] === 0xff && data[1] === 0xfe ? "utf-16le"
    : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : resource.charset;
  if (!charset && (resource.contentType.endsWith("+xml") || ["application/xml", "text/xml"].includes(resource.contentType))) {
    // XML declarations precede the root element. UTF-16 signatures allow reading
    // declarations even when the response omits both the BOM and HTTP charset.
    charset = data.subarray(0, 4).equals(Buffer.from([0x00, 0x3c, 0x00, 0x3f])) ? "utf-16be"
      : data.subarray(0, 4).equals(Buffer.from([0x3c, 0x00, 0x3f, 0x00])) ? "utf-16le"
      : data.subarray(0, 1024).toString("latin1").match(/^<\?xml\s+[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/i)?.[2];
  }
  if (!charset && resource.contentType === "text/html") {
    const sniff = new Parser({ onopentag(name, attributes) {
      if (name !== "meta" || charset) return;
      charset = attributes.charset?.trim() || (attributes["http-equiv"]?.toLowerCase() === "content-type"
        ? contentCharset(attributes.content ?? "") : undefined);
      // HTML metadata cannot select UTF-16 without a BOM; those labels imply UTF-8.
      if (/^utf-16(?:le|be)?$/i.test(charset ?? "")) charset = "utf-8";
    } });
    sniff.end(data.subarray(0, 1024).toString("latin1"));
  }
  try { return new TextDecoder(charset || "utf-8", { fatal: true }).decode(data); }
  catch { throw new PublicFetchError("unsupported", "The page could not be decoded using its declared character encoding (or UTF-8 when none is declared)."); }
}

export const fetchWebpageResource: typeof fetchPublicResource = (url, options) =>
  ebayListingUrl(url) ? fetchBrowserResource("ebay")(url, options) : fetchPublicResource(url, options);

export async function fetchWebpage(rawUrl: string, signal?: AbortSignal,
  fetchResource: typeof fetchPublicResource = fetchWebpageResource,
  options: { mode?: "auto" | "browser"; offset?: number; textLimit?: number; browserReader?: typeof fetchPublicResource } = {}): Promise<WebpageResult> {
  const operation = operationSignal(signal, 45_000);
  const fetchedAt = () => new Date().toISOString();
  let url: string;
  try { url = lookupUrl(rawUrl); }
  catch {
    operation.dispose();
    return { status: "unavailable", url: "(invalid URL)", fetchedAt: fetchedAt(), errorCode: "policy_blocked", message: "Use a public HTTP(S) URL without credentials." };
  }
  try {
    const offset = options.offset ?? 0;
    const textLimit = options.textLimit ?? MAX_TEXT;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_DOCUMENT_TEXT) throw new PublicFetchError("unsupported", "Text offset must be between 0 and 191999.");
    if (!Number.isSafeInteger(textLimit) || textLimit < 1 || textLimit > MAX_DOCUMENT_TEXT) throw new PublicFetchError("unsupported", "Invalid text chunk size.");
    let file: PublicResource | undefined;
    let reader: "http" | "browser" = options.mode === "browser" ? "browser" : "http";
    const browserReader = options.browserReader ?? fetchBrowserResource("general");
    const canRender = !!options.browserReader || fetchResource === fetchWebpageResource;
    for (let attempt = 0; attempt < 2; attempt++) {
      operation.signal.throwIfAborted();
      try {
        file = await (reader === "browser" ? browserReader : fetchResource)(url, { signal: operation.signal, maxBytes: MAX_BYTES, standardPortsOnly: true });
        break;
      } catch (error) {
        // Browser fallback is a normal anonymous read, never a retry of private-network policy failures.
        if (reader === "http" && canRender && !ebayListingUrl(url) && error instanceof PublicFetchError && error.code === "http_error" && error.status === 403) {
          reader = "browser";
          file = await browserReader(url, { signal: operation.signal, maxBytes: MAX_BYTES, standardPortsOnly: true });
          break;
        }
        // A single retry for transient transport/server failures. Never retry refusals or policy blocks.
        const transient = !(error instanceof PublicFetchError) || error.code === "network_error"
          || (error.code === "http_error" && (error.status ?? 0) >= 500);
        if (attempt || !transient || operation.signal.aborted) throw error;
        await delay(300, undefined, { signal: operation.signal });
      }
    }
    operation.signal.throwIfAborted();
    let resource = file!;
    let page: ReturnType<typeof extractWebpage>;
    if (["text/html", "application/xhtml+xml"].includes(resource.contentType)) {
      const html = decodeWebpage(resource);
      page = extractWebpage(html, MAX_DOCUMENT_TEXT);
      if (reader === "http" && canRender && !ebayListingUrl(url) && page.text.length < 500 && !page.structuredData.length && /<script\b/i.test(html)
        && !/^(?:just a moment|access denied|robot check|verify you are human|security check)/i.test(page.title)) {
        resource = await browserReader(url, { signal: operation.signal, maxBytes: MAX_BYTES, standardPortsOnly: true });
        page = extractWebpage(decodeWebpage(resource), MAX_DOCUMENT_TEXT);
        reader = "browser";
      }
    }
    else if (["text/plain", "application/json"].includes(resource.contentType)) {
      const text = decodeWebpage(resource);
      page = { title: "", text: text.slice(0, MAX_DOCUMENT_TEXT), structuredData: [], truncated: text.length > MAX_DOCUMENT_TEXT, links: [], baseHref: undefined };
    } else if (["application/rss+xml", "application/atom+xml", "application/xml", "text/xml"].includes(resource.contentType)) {
      const feed = parseFeed(decodeWebpage(resource));
      if (!feed) throw new PublicFetchError("unsupported", "The XML document is not an RSS or Atom feed.");
      const text = feed.items.map(item => [item.title, item.link, item.pubDate && Number.isFinite(item.pubDate.getTime()) ? item.pubDate.toISOString() : "", extractWebpage(item.description ?? "").text.slice(0,2000)].filter(Boolean).join("\n")).join("\n\n");
      page = { title: feed.title ?? "", text: text.slice(0, MAX_DOCUMENT_TEXT), structuredData: [], truncated: text.length > MAX_DOCUMENT_TEXT, links: feed.items.flatMap(item => item.link ? [item.link] : []).slice(0,120), baseHref: undefined };
    } else throw new PublicFetchError("unsupported", "This URL did not return a webpage, text, JSON, RSS, or Atom. Use fetch_artifact for files.");
    if (/^(?:pardon our interruption|just a moment|access denied|robot check|verify you are human|security check|checking your browser)\b/i.test(page.title)
      || (!page.structuredData.length && page.text.length < 1500 && /^(?:please )?(?:verify (?:that )?you are human|checking your browser|pardon our interruption)\b/i.test(page.text))) {
      return { status: "unavailable", url, fetchedAt: fetchedAt(), errorCode: "challenge", message: "The source returned a verification/challenge page; its content is unavailable." };
    }
    if (!page.text && !page.structuredData.length) return { status: "unavailable", url, fetchedAt: fetchedAt(), errorCode: "unreadable", message: "The page has no readable content; it may require JavaScript or authentication." };
    let baseUrl = resource.url;
    try { if (page.baseHref !== undefined) baseUrl = new URL(page.baseHref, resource.url).href; } catch { /* Invalid base URLs use the document URL. */ }
    const links = [...new Set(page.links.flatMap(link => { try { const target = new URL(link, baseUrl); return ["http:", "https:"].includes(target.protocol) && !target.username && !target.password ? [target.href] : []; } catch { return []; } }))];
    const nextOffset = offset + textLimit < page.text.length ? offset + textLimit : undefined;
    return { status: "available", url, finalUrl: resource.url, fetchedAt: fetchedAt(), ...page, links, reader: ebayListingUrl(url) && fetchResource === fetchWebpageResource ? "browser" : reader,
      text: page.text.slice(offset, offset + textLimit), truncated: page.truncated || nextOffset !== undefined,
      ...(nextOffset !== undefined ? { nextOffset: String(nextOffset) } : {}) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const code = operation.signal.aborted ? "timeout" : error instanceof PublicFetchError ? error.code : "network_error";
    return { status: "unavailable", url, fetchedAt: fetchedAt(), errorCode: code,
      message: code === "timeout" ? "The webpage request timed out." : error instanceof PublicFetchError ? error.message : "Could not connect to the public source.",
      ...(error instanceof PublicFetchError && error.status ? { httpStatus: error.status } : {}) };
  } finally { operation.dispose(); }
}
