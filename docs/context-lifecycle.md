# Session context lifecycle

Discord conversation keys still identify the same logical conversation. Before each queued message runs, `resolveSessionContext()` reads the current operator prompt, the requester's enabled rulesets, application instructions, tool contracts, and host security settings. Editing a prompt file or a ruleset takes effect on the next turn, including queued turns. Changing container environment variables still requires recreating the container.

The snapshot has separate SHA-256 fingerprints for instructions and capabilities. Session files store these fingerprints alongside the provider session ID. They do not store a second copy of policy text or tool credentials. Legacy string-only session records are read automatically; their context is considered unknown until refreshed. Back up these files with the rest of `/data`.

Before upgrading, save a private backup of `/data/.config/ai-assistant/sessions*.json`. Older releases expect string-only records and cannot read the new object records. Downgrading therefore requires restoring compatible session maps while the assistant is stopped, or deliberately resetting the affected sessions; changing only the image tag is insufficient. Preserve provider history and other persistent data. Restoring an older map can omit conversation progress made after that backup.

## Provider behavior

| Provider | Applying current context | History and compaction |
| --- | --- | --- |
| Copilot | Disconnect and resume the same session with the complete current `systemMessage` and MCP configuration when either changes. | Native session history remains; instructions belong to the session configuration, outside compacted message history. |
| OpenCode | Supply the complete current native agent prompt and MCP configuration on every invocation. | Continue the same session ID; every turn receives current instructions independently of its compacted history. |
| Codex SDK | When persisted fingerprints differ, summarize the old thread and start a fresh thread configured with current developer instructions. | Deliver the summary as historical user data. Unchanged threads resume normally, including after a bot restart; native compaction reconstructs configured instructions. |

There is no age-based reset. Repeating policy as ordinary chat messages would add tokens without reliably replacing old instructions. Changes during a running turn apply to the next turn; this is not an emergency revocation mechanism. Host-side authorization remains responsible for enforcing permissions immediately.

Codex refresh adds one model call and a bounded, potentially lossy summary. The summary asks for goals, facts, decisions, unfinished work, speaker attribution, and durable references, excluding policy and credentials. It runs with read-only filesystem permissions, network and web search disabled, and shell, MCP, apps, plugins, and subagents disabled. The tested Codex runtime still advertises `apply_patch` from model metadata; the read-only policy rejects attempted writes. The runtime test verifies this restriction. Do not describe this as a tool-free inference endpoint.

If summarization fails, the original mapping remains and the request fails instead of running with stale policy. If the provider explicitly reports that the source thread no longer exists, discard that irrecoverable mapping and start fresh (retaining any already-saved handoff). Once the replacement thread starts, its ID and pending handoff are saved atomically. The handoff remains available for retries and process restarts until the first successful turn. If native resume cannot read an interrupted replacement thread, a bounded retry can transfer that saved handoff to another fresh thread; unrelated resume errors still fail without resetting established history. A persistence failure is an error, not a successful refresh. Session files can temporarily contain conversation summaries and should retain their private file permissions. This uses the SDK's public thread API, not private transcript rewriting or App Server.

## Adding a contributor

Add an entry to `CONTEXT_CONTRIBUTORS` in `src/common/sessionContext.ts`. Keep the registry small and application-owned. Each entry needs a stable, unique ID, explicit profiles, and a resolver that returns current instruction text and/or a JSON-serializable capability description. Return `undefined` when disabled. Do not append durable feature instructions directly to provider-specific user messages.

```ts
{
  id: "example-tools",
  profiles: ["conversation", "scheduled"],
  resolve: () => exampleEnabled() ? {
    instructions: EXAMPLE_INSTRUCTIONS,
    capabilities: { tools: EXAMPLE_TOOL_DEFINITIONS, behaviorRevision: 1 },
  } : undefined,
}
```

Fingerprint the effective public contract: tool names, descriptions, argument schemas, feature availability, and an explicit revision when semantics change without changing those fields. Arrays preserve order; object keys are canonicalized. Do not include timestamps, random IDs, ports, bearer tokens, passwords, or a whole environment/configuration object. Connection bindings can change without changing policy; provider adapters refresh those bindings separately.

Registering a capability does **not** install its MCP server or grant permissions. Wire the actual tool availability into every supported adapter and enforce access in the host tool implementation. Disabled features must disappear from both the snapshot and the native tool configuration. Fingerprints detect changes; they do not provide a security boundary.

Choose a scope deliberately:

- `conversation`: normal Discord requests, including shared bot-owned threads.
- `scheduled`: scheduled work with its explicitly supplied requester identity.
- `ephemeral`: temporary workspaces/runs. Operator, security, and artifact context apply; user rulesets and their management tools are excluded.

Participation classification has a separate minimal, tool-restricted contract and does not opt into conversation context. Never infer the requester from the conversation key: shared threads can have multiple speakers. Use `userInstructionContext` supplied by the caller. Display names and current speaker metadata are refreshed in the turn envelope without causing policy changes on nickname edits. Switching to a requester with different active rules changes the effective policy and may rotate a Codex thread.

## What belongs where

| Input | Treatment |
| --- | --- |
| Operator prompt, enabled user rules, durable feature instructions | Contributor instruction text. Include removals and disabling in tests. |
| Browser/artifact MCP tool schemas and descriptions | Already enrolled through `ARTIFACT_TOOLS` and `ARTIFACT_INSTRUCTIONS`; new tools added there participate automatically. |
| New host-owned MCP tool family | Contributor capability contract, native adapter wiring, and host authorization. |
| Artifact run ID, attachment manifest, current requester, transient bridge token/port | Per-turn envelope or private connection binding; exclude from persisted fingerprints. |
| Retrieved pages, other people's messages, memory recall, handoff summaries | Historical/untrusted data, never elevated into policy or permissions. |
| Operator-installed provider skills, personal MCP servers, workspace configuration | Provider-owned discovery; not automatically covered by this registry. Enroll an explicit sanitized contract if the application needs to manage their lifecycle. |

Validate a new contributor with focused tests for edits, removal, unrelated-user isolation, and supported profiles. Adapter changes need coverage for unchanged resumes, changed context, failed refreshes, and restart recovery. `tests/codexContextRuntime.test.ts` exercises the installed Codex binary against a local mock Responses endpoint, with no real inference credentials. Rerun it when updating the SDK/runtime, because native compaction and tool availability are provider contracts.
