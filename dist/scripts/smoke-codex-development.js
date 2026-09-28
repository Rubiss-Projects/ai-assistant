import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { codexClientOptions, codexShellEnvironment, createCodexSessionTemporaryDirectory, prepareCodexWorkingDirectory, } from "../src/providers/codex.js";
// Run the real repository in the production shell sandbox without model calls or logins.
// The outer harness copies only development inputs from a read-only source mount.
const source = process.argv[2];
assert.ok(source, "Usage: smoke-codex-development.js /source");
const root = "/data/workspaces";
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync("/data/.codex", { recursive: true, mode: 0o700 });
const workspace = fs.mkdtempSync(path.join(root, "development-check-"));
const temporary = createCodexSessionTemporaryDirectory();
const checkout = path.join(temporary, "checkout");
const hostDirectory = fs.mkdtempSync("/data/development-host-only-");
const hostSocket = path.join(hostDirectory, "control.sock");
const hostTcp = createServer(socket => socket.destroy());
const hostUnix = createServer(socket => socket.destroy());
const hostAbstract = createServer(socket => socket.destroy());
const abstractSocket = `\0development-host-${path.basename(hostDirectory)}`;
process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
process.env.AI_ASSISTANT_WORKSPACE_ROOT = workspace;
process.env.AI_ASSISTANT_ENABLE_SITES = "false";
try {
    await new Promise(resolve => hostTcp.listen(0, "127.0.0.2", resolve));
    await new Promise(resolve => hostUnix.listen(hostSocket, resolve));
    await new Promise(resolve => hostAbstract.listen(abstractSocket, resolve));
    const address = hostTcp.address();
    assert.ok(address && typeof address !== "string");
    const endpoints = [{ host: "127.0.0.2", port: address.port }, { path: hostSocket }, { path: abstractSocket }];
    fs.writeFileSync(path.join(temporary, "network-probe.mjs"), `
    import assert from "node:assert/strict";
    import { createConnection } from "node:net";
    for (const endpoint of ${JSON.stringify(endpoints)}) {
      const connected = await new Promise(resolve => {
        const socket = createConnection(endpoint);
        socket.setTimeout(1000);
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
        socket.once("timeout", () => { socket.destroy(); resolve(false); });
      });
      assert.equal(connected, false, "Host endpoint must remain inaccessible: " + JSON.stringify(endpoint));
    }
  `);
    fs.mkdirSync(checkout);
    for (const name of ["src", "scripts", "tests", ".agents/skills/babysit-contribution", "package.json", "package-lock.json", "patch-deps.cjs", "tsconfig.json"])
        fs.cpSync(path.join(source, name), path.join(checkout, name), { recursive: true });
    prepareCodexWorkingDirectory(workspace);
    fs.writeFileSync(path.join(workspace, ".env"), "DENIED_FIXTURE=not-a-credential");
    const options = codexClientOptions(temporary);
    assert.ok(options.env);
    const environment = codexShellEnvironment(workspace, options.env);
    const sandbox = (command, timeout = 300_000) => {
        const result = spawnSync(process.env.CODEX_EXECUTABLE_PATH || "codex", [
            "sandbox", "-C", workspace, "-P", "discord-bot",
            "-c", "features.network_proxy=true",
            ...(options.configOverrides ?? []).flatMap(value => ["-c", value]),
            "--", "/usr/bin/env", "-u", "CODEX_HOME", `HOME=${workspace}`, `USERPROFILE=${workspace}`,
            "/bin/sh", "-c", command,
        ], {
            // The Codex launcher owns its proxy state outside the sandbox; shell HOME stays isolated.
            env: { ...environment, HOME: "/data", CODEX_HOME: "/data/.codex" },
            encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024,
        });
        fs.writeSync(1, result.stdout ?? "");
        fs.writeSync(2, result.stderr ?? "");
        if (result.status !== 0 && fs.existsSync(path.join(temporary, "tests.log"))) {
            const lines = fs.readFileSync(path.join(temporary, "tests.log"), "utf8").split("\n");
            const failures = lines.flatMap((line, index) => line.startsWith("not ok") ? lines.slice(index, index + 22) : []);
            fs.writeSync(2, failures.join("\n").slice(0, 24_000));
        }
        assert.ifError(result.error);
        assert.equal(result.status, 0, `Sandbox command failed: ${command}`);
    };
    sandbox('node "$TMPDIR/network-probe.mjs"');
    sandbox('cd "$TMPDIR/checkout" && npm ci --include=dev --no-audit --no-fund --fetch-retries=0');
    // Separate invocations catch permission masking of npm's generated hidden files.
    sandbox('cd "$TMPDIR/checkout" && npm run check > "$TMPDIR/tests.log" 2>&1; result=$?; tail -n 12 "$TMPDIR/tests.log"; exit "$result"');
    sandbox([
        "set -eu",
        "if cat .env >/dev/null 2>&1; then exit 20; fi",
        "if ls .codex >/dev/null 2>&1; then exit 21; fi",
        "if curl --fail --silent --max-time 10 https://example.com >/dev/null; then exit 22; fi",
        "if curl --fail --silent --max-time 10 http://169.254.169.254/latest/meta-data/ >/dev/null; then exit 23; fi",
    ].join("; "));
    console.log("Codex development: clean install, build and full tests pass; credentials and unapproved network destinations stay blocked.");
}
finally {
    for (const server of [hostTcp, hostUnix, hostAbstract])
        server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
}
