/**
 * Manual end-to-end check for the Claude provider against a real Claude login.
 * Usage: CLAUDE_SMOKE_WORKSPACE=/abs/dir npx tsx scripts/smoke-claude.ts
 * Runs in shared mode: status, models, a turn, a resume, history, an artifact and a denied shell call.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { SessionStore } from "../src/common/sessionStore.js";
import { ClaudeProvider } from "../src/providers/claude.js";
const workspace = process.env.CLAUDE_SMOKE_WORKSPACE;
if (!workspace)
    throw new Error("Set CLAUDE_SMOKE_WORKSPACE to an empty directory.");
process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
process.env.AI_ASSISTANT_WORKSPACE_ROOT = workspace;
const store = new SessionStore("claude", path.join(mkdtempSync(path.join(os.tmpdir(), "claude-smoke-")), "sessions.json"));
const provider = new ClaudeProvider(store);
const key = "smoke";
try {
    const status = await provider.getStatus();
    console.log("status:", status);
    assert.ok(status.authStatus.isAuthenticated, "Claude is not authenticated");
    console.log("models:", (await provider.listModels()).map((model) => model.id).join(", "));
    const first = await provider.sendMessage(key, "Remember the codeword PINEAPPLE-42. Reply with just OK.");
    console.log("turn 1:", first.content);
    const second = await provider.sendMessage(key, "What codeword did I give you? Reply with just the codeword.");
    console.log("turn 2:", second.content);
    assert.match(second.content, /PINEAPPLE-42/);
    const history = await provider.getHistory(key);
    console.log("history events:", history?.length);
    assert.ok(history && history.length >= 4);
    const artifact = await provider.sendMessage(key, "Create a text file named hello.txt containing 'hello from claude' and attach it to your reply.");
    console.log("artifact turn:", artifact.content, artifact.attachments.map((file) => `${file.displayName} (${file.data.length} bytes)`));
    assert.ok(artifact.attachments.some((file) => file.data.toString().includes("hello from claude")));
    const shell = await provider.sendMessage(key, "Run the shell command `echo $HOME` with Bash and tell me the exact output, or say BLOCKED if you cannot run shell commands.");
    console.log("shell turn:", shell.content);
    assert.doesNotMatch(shell.content, new RegExp(os.homedir().replaceAll("/", "\\/")));
    await provider.resetSession(key);
    assert.equal(await provider.getHistory(key), null);
    console.log("SMOKE OK");
}
finally {
    await provider.shutdown();
}
