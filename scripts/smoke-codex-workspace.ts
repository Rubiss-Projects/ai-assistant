import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  codexFilesystemPermissionOverride,
  createCodexSessionTemporaryDirectory,
  prepareCodexWorkingDirectory,
} from "../src/providers/codex.js";

// Exercise the production sandbox without model calls, credentials, or Discord.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-smoke-"));
const temporary = createCodexSessionTemporaryDirectory();
process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
process.env.AI_ASSISTANT_WORKSPACE_ROOT = root;
try {
  const runs = path.join(root, ".scheduled-runs");
  fs.mkdirSync(runs);
  for (const sites of [false, true]) {
    const workspace = fs.mkdtempSync(path.join(runs, "run-"));
    prepareCodexWorkingDirectory(workspace);
    fs.writeFileSync(path.join(workspace, "visible.txt"), "visible fixture");
    fs.writeFileSync(path.join(workspace, ".env"), "denied fixture");
    const result = spawnSync(process.env.CODEX_EXECUTABLE_PATH || "codex", [
      "sandbox", "-C", workspace, "-P", "discord-bot",
      "-c", codexFilesystemPermissionOverride(sites),
      "-c", "permissions.discord-bot.network={enabled=false}",
      "--", "/bin/sh", "-c", [
        "set -eu",
        'test "$(cat visible.txt)" = "visible fixture"',
        "echo ok > output.txt",
        "if ls .codex >/dev/null 2>&1; then exit 20; fi",
        "if cat .env >/dev/null 2>&1; then exit 21; fi",
      ].join("; "),
    ], {
      encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Fresh workspace sandbox (Sites=${sites}): ${result.stderr}`);
    assert.equal(fs.readFileSync(path.join(workspace, "output.txt"), "utf8"), "ok\n");
  }
  console.log("Fresh Codex workspaces: sandbox starts, workspace writes succeed, .codex and .env remain denied.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(temporary, { recursive: true, force: true });
}
