import { spawn } from "node:child_process";
/** Provider-owned lifecycle, including model discovery and in-flight requests. */
export class ParticipationProcessRunner {
    abort = new AbortController();
    active = new Set();
    run(binary, args, options) {
        const result = runParticipationProcess(binary, args, { ...options, signal: this.abort.signal });
        this.active.add(result);
        void result.then(() => this.active.delete(result), () => this.active.delete(result));
        return result;
    }
    async shutdown() {
        this.abort.abort();
        await Promise.allSettled([...this.active]);
    }
}
/** Bounded, shell-free process runner for isolated classification requests. */
export function runParticipationProcess(binary, args, options) {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new Error("Participation evaluator stopped."));
            return;
        }
        const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let failure;
        const abort = () => { failure = new Error("Participation evaluator stopped."); child.kill("SIGKILL"); };
        options.signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => {
            failure = new Error("Participation evaluator timed out.");
            child.kill("SIGKILL");
        }, options.timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 256_000) {
                failure = new Error("Participation evaluator output exceeded its limit.");
                child.kill("SIGKILL");
            }
        });
        // Drain diagnostics, but never expose provider output (which may contain input or credentials).
        child.stderr.resume();
        child.stdin.on("error", () => { });
        child.on("error", () => { clearTimeout(timeout); reject(new Error("Could not start participation evaluator.")); });
        child.on("close", code => {
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            if (failure)
                reject(failure);
            else if (code !== 0)
                reject(new Error(`Participation evaluator exited with code ${code}.`));
            else
                resolve(stdout);
        });
        child.stdin.end(options.stdin ?? "");
    });
}
