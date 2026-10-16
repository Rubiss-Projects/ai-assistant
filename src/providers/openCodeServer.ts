import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { runParticipationProcess } from "./participationProcess.js";
import { RunTimeoutError } from "./types.js";

type ServerOptions = { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; mcpServers: string[] };

/** Own a private V2 server for one turn. V2 starts MCP asynchronously; wait for
 * the configured bridges before the first model request so its tools are present.
 * The stdio lease and explicit cleanup keep the server tied to the turn's lifetime.
 */
export async function withOpenCodeServer<T>(binary: string, options: ServerOptions,
  action: (url: string, env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<T>): Promise<T> {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const env = { ...options.env, OPENCODE_PASSWORD: randomBytes(32).toString("hex") };
  const timeout = setTimeout(() => lifetime.abort(new RunTimeoutError("OpenCode", options.timeoutMs, true)), options.timeoutMs);
  const server = spawn(binary, ["serve", "--stdio", "--port", "0"], { cwd: options.cwd, env, signal, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
  server.stdin.on("error", () => {});
  server.stderr.resume();
  let closed = false;
  const done = new Promise<void>(resolve => {
    server.once("close", () => { closed = true; resolve(); });
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      server.on("error", reject);
      server.once("close", () => reject(new Error("OpenCode server exited before reporting readiness.")));
      server.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 16_384) { reject(new Error("OpenCode server readiness output exceeded its limit.")); return; }
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        try {
          const ready: unknown = JSON.parse(output.slice(0, newline));
          if (!ready || typeof ready !== "object" || !("url" in ready) || typeof ready.url !== "string") throw new Error("Invalid OpenCode server readiness response.");
          const address = new URL(ready.url);
          if (address.protocol !== "http:" || address.hostname !== "127.0.0.1") throw new Error("OpenCode server must bind to loopback.");
          resolve(ready.url);
        } catch (error) { reject(error); }
      });
    });
    server.once("close", () => lifetime.abort(new Error("OpenCode server exited during the turn.")));
    // The CLI resolves the released API's route and authentication; no generated
    // client or hardcoded server API contract needs to be kept in sync here.
    while (true) {
      signal.throwIfAborted();
      const stdout = await runParticipationProcess(binary, ["api", "mcp.list", "--server", url, "--param", `directory=${options.cwd ?? process.cwd()}`], {
        cwd: options.cwd ?? process.cwd(), env, signal, timeoutMs: options.timeoutMs,
      });
      const result = JSON.parse(stdout) as { data: { name: string; status: { status: string } }[] };
      const configured = options.mcpServers.map(name => result.data.find(server => server.name === name));
      const enabled = result.data.filter(server => server.status.status !== "disabled");
      if (configured.every(server => server?.status.status === "connected") && enabled.every(server => server.status.status === "connected")) break;
      if (enabled.some(server => !["pending", "connected"].includes(server.status.status))) throw new Error("An OpenCode MCP server failed to connect.");
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    return await action(url, env, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    server.stdin.end();
    if (!closed) {
      const force = setTimeout(() => server.kill("SIGKILL"), 5_000);
      await done;
      clearTimeout(force);
    }
  }
}
