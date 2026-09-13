import type { CDPSession } from "playwright-core";
import { PublicFetchError } from "./fetchArtifact.js";

export const MAX_BROWSER_DOM_NODES = 50_000;

/** Runs in an isolated world so page scripts cannot replace the traversal/encoding intrinsics. */
function snapshotDocument(bounds: { maxBytes: number; maxNodes: number }) {
  const parts: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0, nodes = 0, exceeded = false;
  const append = (text: string) => {
    // Bound before encoding or appending; never serialize a whole subtree first.
    if (exceeded || parts.length >= 200_000 || text.length > bounds.maxBytes - bytes) { exceeded = true; return; }
    bytes += encoder.encode(text).byteLength;
    if (bytes > bounds.maxBytes) exceeded = true;
    else parts.push(text);
  };
  const escaped = (text: string, attribute = false) => {
    if (text.length > bounds.maxBytes - bytes) { exceeded = true; return; }
    for (let start = 0; start < text.length && !exceeded; start += 4096) {
      append(text.slice(start, start + 4096).replace(attribute ? /[&<>\"]/g : /[&<>]/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[value]!)));
    }
  };
  const walk = (node: Node, depth: number) => {
    if (exceeded) return;
    if (++nodes > bounds.maxNodes || depth > 256) { exceeded = true; return; }
    if (node.nodeType === Node.TEXT_NODE) { escaped(node.nodeValue ?? ""); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const name = element.localName;
    if (["style", "noscript", "template", "svg"].includes(name)) return;
    if (name === "script") {
      if (element.getAttribute("type")?.toLowerCase() !== "application/ld+json" || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return;
      // JSON-LD is a raw-text element. Bound each existing text node before append.
      append('<script type="application/ld+json">');
      for (let child = node.firstChild; child && !exceeded; child = child.nextSibling) {
        if (++nodes > bounds.maxNodes) { exceeded = true; break; }
        const text = child.nodeValue ?? "";
        if (text.length > bounds.maxBytes - bytes) { exceeded = true; break; }
        for (let start = 0; start < text.length && !exceeded; start += 4096) append(text.slice(start, start + 4096).replace(/</g, "\\u003c"));
      }
      append("</script>");
      return;
    }
    append(`<${name}`);
    for (const attribute of element.attributes) {
      if (exceeded) break;
      append(` ${attribute.name}="`); escaped(attribute.value, true); append('"');
    }
    append(">");
    for (let child = node.firstChild; child && !exceeded; child = child.nextSibling) walk(child, depth + 1);
    // Include open shadow roots used by ordinary public web components.
    if (element.shadowRoot) for (let child = element.shadowRoot.firstChild; child && !exceeded; child = child.nextSibling) walk(child, depth + 1);
    if (!["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(name)) append(`</${name}>`);
  };
  if (document.documentElement) walk(document.documentElement, 0);
  return { exceeded, html: exceeded ? "" : parts.join("") };
}

export async function boundedBrowserDocument(cdp: CDPSession, maxBytes: number): Promise<string> {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "rook-public-reader" });
  const result = await cdp.send("Runtime.callFunctionOn", {
    executionContextId, functionDeclaration: snapshotDocument.toString(),
    arguments: [{ value: { maxBytes, maxNodes: MAX_BROWSER_DOM_NODES } }], returnByValue: true,
  });
  if (result.exceptionDetails || result.result.value?.exceeded || typeof result.result.value?.html !== "string") {
    throw new PublicFetchError("too_large", "Rendered page exceeds the DOM or serialized-content budget.");
  }
  return result.result.value.html;
}
