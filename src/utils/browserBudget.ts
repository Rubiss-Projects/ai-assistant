import type { Browser } from "playwright-core";
import { PublicFetchError } from "./fetchArtifact.js";

// Chromium counts threads against the container PID limit. Two instances reached
// the shipped 256-task bound in a concurrent auction/news check on Docker Desktop.
const MAX_BROWSERS = 1;
let active = 0;
type Waiter = { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void };
const waiting = new Set<Waiter>();

/** One admission limit shared by all providers, responses, and both browser readers. */
export function acquireBrowserSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const release = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      for (const waiter of waiting) {
        waiting.delete(waiter);
        waiter.signal.removeEventListener("abort", waiter.abort);
        if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
        active++;
        waiter.resolve(release());
        break;
      }
    };
  };
  if (active < MAX_BROWSERS) { active++; return Promise.resolve(release()); }
  if (waiting.size >= 32) return Promise.reject(new PublicFetchError("network_error", "The browser reader is busy. Use hosted article reading or try later."));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject, abort: () => { waiting.delete(waiter); reject(signal.reason); } };
    waiting.add(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
    if (signal.aborted) waiter.abort();
  });
}

/** An aborted launch keeps its slot until the late process has actually closed. */
export async function closeBrowserAndRelease(browser: Browser | undefined, launch: Promise<Browser> | undefined, release?: () => void): Promise<void> {
  if (browser) { await browser.close().catch(() => {}); release?.(); }
  else if (launch) { void launch.then(value => value.close()).catch(() => {}).finally(() => release?.()); }
  else release?.();
}
