import { spawn } from "node:child_process";
/** Bounded, shell-free process runner for isolated classification requests. */
export function runParticipationProcess(binary, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let failure;
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
