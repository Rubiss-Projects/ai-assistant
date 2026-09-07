/** Compose cancellation and a deadline without AbortSignal.any (Node 18.17+). */
export function operationSignal(parent, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    const timer = setTimeout(() => controller.abort(new Error("Artifact operation timed out.")), timeoutMs);
    timer.unref();
    const dispose = () => {
        clearTimeout(timer);
        parent?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", dispose);
    };
    controller.signal.addEventListener("abort", dispose, { once: true });
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted)
        abort();
    return { signal: controller.signal, dispose };
}
