import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this validation with npm run check.");

// Test servers live in the sandbox's own loopback namespace. Sending them to the
// outbound package proxy would target the host's loopback instead.
const home = mkdtempSync(join(tmpdir(), "ai-assistant-test-home-"));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
};
try {
  for (const script of ["build", "test"]) {
    const result = spawnSync(process.execPath, [npm, "run", script], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
