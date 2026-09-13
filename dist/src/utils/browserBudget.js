import { PublicFetchError } from "./fetchArtifact.js";
const MAX_BROWSERS = 2;
let active = 0;
const waiting = new Set();
/** One admission limit shared by all providers, responses, and both browser readers. */
export function acquireBrowserSlot(signal) {
    signal.throwIfAborted();
    const release = () => {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            active--;
            for (const waiter of waiting) {
                waiting.delete(waiter);
                waiter.signal.removeEventListener("abort", waiter.abort);
                if (waiter.signal.aborted) {
                    waiter.reject(waiter.signal.reason);
                    continue;
                }
                active++;
                waiter.resolve(release());
                break;
            }
        };
    };
    if (active < MAX_BROWSERS) {
        active++;
        return Promise.resolve(release());
    }
    if (waiting.size >= 32)
        return Promise.reject(new PublicFetchError("network_error", "The browser reader is busy. Use hosted article reading or try later."));
    return new Promise((resolve, reject) => {
        const waiter = { signal, resolve, reject, abort: () => { waiting.delete(waiter); reject(signal.reason); } };
        waiting.add(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
        if (signal.aborted)
            waiter.abort();
    });
}
/** An aborted launch keeps its slot until the late process has actually closed. */
export async function closeBrowserAndRelease(browser, launch, release) {
    if (browser) {
        await browser.close().catch(() => { });
        release?.();
    }
    else if (launch) {
        void launch.then(value => value.close()).catch(() => { }).finally(() => release?.());
    }
    else
        release?.();
}
