import { Parser } from "htmlparser2";

export interface BrowserDiagnostics {
  finalUrl?: string;
  title?: string;
  excerpt?: string;
  navigations: Array<{ url: string; status?: number; redirectUrl?: string }>;
}

/** Diagnostic URLs exclude credentials, queries and fragments (including challenge tokens). */
export function diagnosticUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "(non-HTTP URL)";
    return `${url.origin}${url.pathname}`.slice(0, 1024);
  } catch { return "(invalid URL)"; }
}

export function isChallengeUrl(raw: string): boolean {
  try { return /^\/splashui\/challenge(?:\/|$)/i.test(new URL(raw).pathname); }
  catch { return false; }
}

export function isChallengePage(title: string, text: string): boolean {
  return /^(?:pardon our interruption|just a moment|access denied|robot check|verify you are human|security check|checking your browser)\b/i.test(title.trim())
    || /^(?:please )?(?:verify (?:that )?you are human|checking your browser|pardon our interruption)\b/i.test(text.trim());
}

/** Bounded evidence from an already size-limited document; page text remains untrusted. */
export function browserEvidence(html: string): Pick<BrowserDiagnostics, "title" | "excerpt"> {
  let title = "", text = "", titleSeen = false;
  const stack: Array<{ hidden: boolean; inert: boolean; title: boolean; titleScope: boolean }> = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      if (stack.length >= 512) { parser.pause(); return; }
      const parent = stack.at(-1);
      const inert = !!parent?.inert || ["script", "style", "noscript", "template", "svg"].includes(name)
        || Object.hasOwn(attributes, "hidden") || attributes["aria-hidden"] === "true";
      const isTitle = name === "title" && !inert && !titleSeen && (!parent || parent.titleScope);
      if (isTitle) titleSeen = true;
      stack.push({
        hidden: !!parent?.hidden || inert || name === "head", inert, title: isTitle,
        titleScope: (name === "html" && !parent) || (name === "head" && (!parent || parent.titleScope)),
      });
    },
    ontext(value) {
      if (stack.at(-1)?.title) title += value.slice(0, Math.max(0, 300 - title.length));
      else if (!stack.at(-1)?.hidden) text += value.slice(0, Math.max(0, 2000 - text.length));
    },
    onclosetag() { if (!stack.pop()?.hidden && text.length < 2000) text += " "; },
  }, { decodeEntities: true });
  parser.end(html);
  return { title: title.trim(), excerpt: text.replace(/\s+/g, " ").trim() };
}

export class BrowserTrace {
  readonly diagnostics: BrowserDiagnostics = { navigations: [] };
  private entries = new Map<string, BrowserDiagnostics["navigations"][number]>();

  request(id: string, url: string): void {
    if (this.diagnostics.navigations.length >= 12) return;
    const entry = { url: diagnosticUrl(url) };
    this.entries.set(id, entry);
    this.diagnostics.navigations.push(entry);
  }

  response(id: string, url: string, status: number, location?: string): void {
    if (!this.entries.has(id)) this.request(id, url);
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = status;
      if (location) {
        try { entry.redirectUrl = diagnosticUrl(new URL(location, url).href); }
        catch { entry.redirectUrl = "(invalid URL)"; }
      }
    }
    this.diagnostics.finalUrl = diagnosticUrl(url);
  }

  document(html: string): void { Object.assign(this.diagnostics, browserEvidence(html)); }
}
