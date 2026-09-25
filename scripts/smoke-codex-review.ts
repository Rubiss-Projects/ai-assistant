import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { reviewSandboxConfiguration } from "../src/common/codexReviewRunner.js";

// Uses the production Codex sandbox without a login or model request.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-isolation-"));
const workspace = path.join(root, "workspace"), temporary = path.join(root, "tools"), host = path.join(root, "host");
for (const directory of [workspace, temporary, host, path.join(workspace, ".codex"), path.join(workspace, ".git")]) fs.mkdirSync(directory, { mode: 0o700 });
fs.writeFileSync(path.join(workspace, "visible.txt"), "visible");
fs.writeFileSync(path.join(workspace, "auth.json"), "fixture");
fs.writeFileSync(path.join(workspace, ".env"), "fixture");
fs.writeFileSync(path.join(host, "auth.json"), "fixture");
fs.mkdirSync(path.join(workspace, "source"));
fs.writeFileSync(path.join(workspace, "source", ".dockerignore"), "safe");
fs.writeFileSync(path.join(workspace, "source", ".env.example"), "safe");
const socket = path.join(host, "review.sock");
// A sibling outside the sandbox retains a canary in its initial environment.
// The sandbox helper's own /proc entries are expected; the client/worker's are not.
const peer = spawn("/bin/sleep", ["30"], { env: { REVIEW_HOST_CANARY: "fixture" } });
const server = createServer((_req, res) => { res.end("privileged"); });
await new Promise<void>(resolve => server.listen(socket, resolve));
try {
  const config = reviewSandboxConfiguration(workspace, temporary);
  const code = [
    "set -eu", 'test "$(cat visible.txt)" = visible',
    'test "$(cat source/.dockerignore)" = safe', 'test "$(cat source/.env.example)" = safe',
    "if (echo write > forbidden) 2>/dev/null; then exit 20; fi",
    ...["auth.json", ".env", `${host}/auth.json`, "/data/.codex/auth.json"].map((file, index) => `if cat '${file}' >/dev/null 2>&1; then exit ${31 + index}; fi`),
    `for p in /proc/[0-9]*; do if cat "$p/root${host}/auth.json" >/dev/null 2>&1; then exit 35; fi; if grep -q REVIEW_HOST_CANARY "$p/environ" 2>/dev/null; then exit 36; fi; done`,
    "if ls .codex >/dev/null 2>&1; then exit 22; fi", "if ls .git >/dev/null 2>&1; then exit 23; fi",
    ...["CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "AI_GITHUB_BRIDGE_TOKEN"].map(name => `test -z "\${${name}+x}"`),
    `if /usr/bin/curl -fsS --max-time 2 --unix-socket '${socket}' http://localhost/ >/dev/null 2>&1; then exit 24; fi`,
    "if /usr/bin/curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsSI https://1.1.1.1 >/dev/null 2>&1; then exit 25; fi",
    "printf '%s\\n' REVIEW_ISOLATION_OK",
  ].join("\n");
  const child = spawn(process.env.CODEX_EXECUTABLE_PATH || "/usr/local/lib/codex/bin/codex", ["sandbox", "-C", workspace, "-P", "review",
    ...config.overrides.filter(value => value.startsWith("permissions.")).flatMap(value => ["-c", value]), "--", "/usr/bin/env", "-i",
    ...Object.entries(config.shell).map(([key, value]) => `${key}=${value}`), "/bin/sh", "-c", code],
  { env: { PATH: process.env.PATH, HOME: "/data", TMPDIR: temporary }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(status, 0, errors);
  assert.match(output, /REVIEW_ISOLATION_OK/);
  console.log("Review isolation passed: source read-only, login/host files hidden, peer process isolated, private socket inaccessible, tool credentials absent, network blocked.");
} finally {
  peer.kill("SIGKILL");
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
