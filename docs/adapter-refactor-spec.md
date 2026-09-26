# Conversation adapter refactor specification

Status: implementation draft. Task deliverables, evidence and acceptance gaps are recorded in section 13.

Revision 2: Slack channel/thread history retrieval is included in the first release, including messages without bot mentions. Explicit mentions still control response initiation; Slack DMs remain deferred.

## 1. Objective and baseline

Extract the conversation orchestration currently embedded in Discord handlers into a shared application service. Discord, Slack, and a local CLI must invoke that service through explicit adapter contracts. Adding another channel/thread transport must not require changes to provider implementations or imports of that transport's SDK into the shared core.

This specification uses the earlier source review of [Rubiss-Projects/ai-assistant at commit 6cead4b](https://github.com/Rubiss-Projects/ai-assistant/tree/6cead4b6ae51cd19f8832f5ae095078a8d77904a). It is not a fresh review of current main. Reconcile these proposed boundaries against the implementation before coding.

The baseline already has useful seams: `SessionManager`, provider contracts, arbitrary string session keys, callback-based participation, and a scheduling adapter. The main extraction target is the orchestration in `src/handlers/mention.ts` and `src/handlers/slash/chat.ts`. Startup, authorization, prompt composition, history, artifacts, and user instructions also retain Discord assumptions.

Normative terms: MUST identifies an acceptance requirement; SHOULD identifies a default that may be changed with a documented reason.

## 2. Scope

The first release MUST provide:

- Discord through the shared service, preserving existing observable behavior and session continuity.
- Slack text conversations in channels where the app is installed and authorized: explicit mentions initiate turns, responses stay in the originating thread, and follow-ups require another explicit mention.
- Slack history enrichment: authorized retrieval of surrounding channel/thread messages, including messages without bot mentions, for context and requested summaries.
- A CLI adapter with interactive and one-shot modes, explicit conversation selection, and real-provider and deterministic fake-provider operation.
- Contracts capable of representing other channel/thread transports without Discord or Slack identifiers appearing in shared business logic.

Slack DMs, file input/output, persistent memory, schedules, proactive participation, and parity with all Discord commands are deferred. Existing Discord capabilities MUST remain available during migration. CLI attachments and scheduling are also deferred.

The design permits direct conversations, but does not enable them automatically. Slack DMs MUST remain rejected in this release. CLI execution MUST use an explicit local execution policy, not masquerade as a DM or bypass shared-mode provider restrictions.

This work does not replace AI providers, adopt a new messaging framework, or unify every platform UI command. A shared conversation is not automatically shared across platforms.

## 3. Architecture and ownership

```text
Discord events / commands    Slack events    CLI input
             \                  |             /
              platform adapters + trusted host context
                               |
                    ConversationService
        authorize → admit turn → prepare context → run → deliver
                               |
                        SessionManager
                               |
                 Copilot / Codex / OpenCode
```

| Component | Owns |
| --- | --- |
| Platform adapter | Event verification, SDK objects, identity/membership lookup, event normalization, platform text parsing, transport acknowledgement, thread creation, formatting, file transfer, typing/progress UI, delivery and platform rate limits |
| Conversation service | Authorization orchestration, capability selection, session resolution, duplicate handling, ordered execution, context composition, provider invocation, cancellation/error lifecycle, turn records |
| Platform-neutral policies and stores | Actor/resource grants, session bindings, turn state, capability definitions and limits |
| Context/tool extensions | Authorized history, message-link resolution, memory, instructions, artifacts and schedules; registered only where supported |
| Provider facade | Provider selection, provider-session lifecycle, execution, model operations and normalized output |
| Composition root | Configuration, enabled adapters/providers, credentials, dependencies, worker startup and graceful shutdown |

Core code MUST NOT import Discord or Slack SDKs, parse their message URLs, download private platform files, or format their user mentions. Provider-facing host capabilities MUST be supplied through interfaces rather than obtained through a Discord client.

Adapters MUST NOT duplicate prompt assembly, authorization policy, provider selection, or turn orchestration. SDK-specific objects MUST stop at the adapter boundary.

## 4. Normalized contracts

The following TypeScript is an interface sketch, not an existing API or a drop-in patch:

```ts
type PlatformId = string; // e.g. discord, slack, cli

interface Principal {
  platform: PlatformId;
  tenantId: string;       // guild, workspace, or configured CLI namespace
  userId: string;
}

interface ConversationRef {
  platform: PlatformId;
  tenantId: string;
  installationId: string; // stable configured logical installation
  channelId: string;
  threadId?: string;
  kind: 'channel' | 'thread' | 'direct';
}

interface IncomingTurn {
  eventId: string;         // stable source event identity for retries
  sourceMessageId?: string;
  actor: Principal;
  conversation: ConversationRef;
  text: string;
  receivedAt: string;
}

interface AdapterCapabilities {
  threads: boolean;
  progress: boolean;
  attachments: boolean;
  history: boolean;
  messageLinks: boolean;
  memory: boolean;
  schedules: boolean;
  directMessages: boolean;
}

interface DeliveryReceipt {
  messageIds: string[];
}

interface TurnDelivery {
  progress(update: ProgressUpdate): Promise<void>;
  send(output: TurnOutput, deliveryKey: string): Promise<DeliveryReceipt>;
}

interface ConversationService {
  submit(
    input: IncomingTurn,
    context: TrustedAdapterContext,
  ): Promise<TurnHandle>;
}
```

`ProgressUpdate`, `TurnOutput`, `TrustedAdapterContext`, and `TurnHandle` MUST be defined as platform-neutral types during implementation. Output SHOULD initially carry plain text plus optional host-owned artifacts for Discord compatibility. Context carries registered identity, access, feature and delivery ports; it is constructed by the host, never deserialized from user content. A turn handle exposes status, completion and cancellation.

Capabilities are deployment-approved adapter capabilities, not claims supplied in an incoming message. Tenant, installation, actor and conversation consistency MUST be validated before provider execution. Native identifier strings MUST remain opaque; the core MUST NOT assume numeric IDs.

## 5. Session identity and conversation semantics

New session keys MUST use a versioned, collision-safe encoding of structured identity, such as a JSON tuple or length-prefixed fields. Plain delimiter concatenation is insufficient. Identity MUST include platform, tenant, installation, channel, conversation kind, effective thread, and audience scope. Actor identity MUST also be included when the selected policy uses individual rather than shared sessions.

Default policies:

| Adapter / surface | Session audience and scope |
| --- | --- |
| Discord existing surfaces | Preserve current keys and semantics through an explicit legacy resolver |
| Slack channel mention | Shared workspace/channel/thread session |
| CLI | Configured local principal plus namespace/channel/thread session |
| Future direct conversations | Explicit private audience policy; disabled unless supported and authorized |

For Slack, a root mention's message timestamp becomes the effective thread ID; a mention already within a thread uses its root thread timestamp. Workspace and channel identity MUST also participate in the key. Provider execution begins only after the effective conversation has been determined.

Existing Discord ordinary mentions, bot-owned threads, `/chat`, and DMs MUST retain their current behavior. Do not silently replace legacy keys with the new format. Use a compatibility resolver or an explicit, tested binding migration that cannot merge unrelated sessions.

Platform-local user IDs MUST NOT be equated across transports. A CLI user cannot claim a Discord or Slack identity by passing a flag. Cross-platform continuation or account linking is outside scope.

Shared thread sessions require a stable context audience: the service MUST NOT place a participant's private memory, private instructions, or inaccessible linked content into provider context that can later be exposed to other participants. Permission checks MUST cover both the requesting actor and the intended conversation audience. If membership or visibility changes invalidate a session's context audience, deny reuse or start a clean session under an explicit policy.

## 6. Turn lifecycle, concurrency and failure handling

The service MUST implement the following sequence:

1. Adapter verifies the source event and derives trusted identity. Ignore bot/self events and unsupported event types.
2. Apply ingress authorization before expensive context or provider work. Resolve the effective conversation without creating unauthorized threads.
3. Atomically claim the deduplication key and persist accepted work. The key includes platform, tenant, installation and source event ID.
4. Execute accepted turns in admission order per resolved session, with independent sessions allowed to run concurrently within global/provider limits.
5. Recheck execution authorization when queued work starts; resolve the effective feature set, retrieve authorized history through the adapter history port, and compose bounded context. History retrieval happens after durable acceptance, outside the transport acknowledgement path.
6. Invoke `SessionManager` with normalized options and a cancellation signal. Throttle optional progress updates; progress failures MUST NOT trigger regeneration.
7. Persist the result before delivery. Deliver with a stable key, record platform receipts, and finish the turn.

Transport acknowledgement MUST be separate from provider completion and satisfy the configured transport's deadline. Acceptance MUST be durable before acknowledging successful receipt. Slack retries MUST return the existing turn status instead of calling the model again.

Use a turn journal with atomic admission and states such as `accepted`, `running`, `generated`, `delivered`, `failed`, `cancelled`, and `interrupted`. Retention MUST cover the configured source retry window; define and document the actual retention and transport deadlines during implementation.

The first deployment MAY use one application worker with durable local storage and per-session locks. It MUST explicitly prevent multiple workers from concurrently owning that store. Horizontal scaling requires a shared journal and distributed ownership; do not imply in-memory locks provide cross-process ordering.

Exactly-once provider execution and remote delivery cannot generally be guaranteed across crashes. On restart, unambiguously unstarted turns may resume, generated results may retry delivery, and ambiguous running turns MUST become interrupted rather than automatically rerun. An ambiguous remote send MUST be reconciled through receipts/platform lookup when available, or reported as uncertain; blind retries can duplicate replies.

Delivery failure MUST NOT regenerate the answer. Failed turns MUST release the session queue. Errors returned to users MUST avoid credentials and private diagnostic content. Apply queue bounds, execution timeouts, cancellation and shutdown rules; unsupported provider cancellation must be reported honestly.

## 7. Authorization and feature isolation

Generalize authorization around namespaced principals, conversation resources, and capabilities. Platform adapters resolve native roles/groups/membership; the core evaluates policy. Existing Discord numeric grant parsing MUST remain a Discord configuration compatibility layer rather than a universal identifier validator.

The effective feature set is the intersection of adapter support, deployment configuration, provider support and requester/resource authorization. This MUST govern both prompt composition and actual tool registration/host enforcement. Hiding a tool name in a prompt is not an access control.

History, links, files and memory MUST be fetched through authorized host ports. Bot visibility alone is insufficient. Each tool call MUST be checked against the current actor, resource and conversation audience. Do not leak credentials into prompts or let providers download Slack private files using exposed tokens.

Slack and CLI prompts MUST describe their real environment and supported output behavior. They MUST NOT advertise Discord summaries, Discord artifacts, GitHub contribution privileges or scheduling tools unless explicitly supported and authorized for that adapter. Existing sandbox restrictions remain enforced independently of adapter selection.

Extract generic user-instruction retrieval separately from Discord guild/global scope translation. Preserve existing Discord behavior while preventing instructions or grants from accidentally crossing tenants or platforms.

## 8. Adapter behavior

### Discord

Move orchestration out of mention and chat handlers. Keep Discord interaction acknowledgement, thread creation, typing, chunking, attachments, mention formatting and delivery in the Discord adapter. Route conversation operations such as reset/model selection through shared application APIs where useful; platform command registration remains local.

Preserve access denials, source visibility checks, reply destinations, session keys, artifact behavior, instruction scope and active participation/scheduling behavior. Existing optional features may remain Discord extensions during extraction; they do not need to become universal to ship this refactor.

### Slack

The MVP supports explicit channel mentions and text replies in threads, including private channels only when installed there and authorized by policy. A plain thread reply without an explicit mention MUST NOT start a turn. Edits, deletions, reactions, bot messages and DMs do not start turns in the MVP.

Provider session continuity supplies context from accepted turns. Slack MUST additionally implement the shared history capability below. Messages without a bot mention are eligible context, but MUST NOT independently initiate provider execution or a reply.

#### Shared history capability and Slack behavior

History enrichment retrieves platform messages to supplement the provider session. It is distinct from persistent memory and does not require a workspace-wide archive or proactive participation.

- On a mention in an existing thread, retrieve its root and a bounded window of preceding replies, including discussion before the bot joined and messages between bot mentions.
- On a root channel mention, retrieve a bounded window of preceding top-level messages from that same channel. Do not automatically expand unrelated threads. Further mentions in the resulting thread default to that thread's context.
- Explicit requests to summarize channel or thread discussion MUST use the same authorized history capability. Initial selectors are the last N messages, a relative duration, after a same-channel message reference, and since the requester's previous message. Scope and selectors MUST be unambiguous; unsupported or ambiguous requests require clarification. The previous-message selector uses the requester's actual preceding message in the selected scope, not an estimated time.
- Automatic context MUST stop at the triggering message's source position, excluding later messages even if execution was queued. Explicit historical requests also require a fixed upper boundary. Supply the triggering message once as the active request.

The host MUST supply a platform-neutral `HistoryPort` through `TrustedAdapterContext`. A request contains a normalized channel/thread resource, range selector, fixed upper boundary, opaque pagination cursor and bounded limits. Actor identity and response audience come from trusted turn context, never model-supplied identity. Every fetch, including subsequent pages and cache hits, MUST pass authorization.

The normalized result MUST contain chronological records with namespaced message IDs, author identity, source timestamp, text, optional thread ID, available revision metadata and a source link where available. Coverage metadata MUST describe requested and returned ranges, complete/partial/empty/unavailable status, truncation and exclusion reasons, and an optional continuation cursor. Empty successful retrieval is distinct from failed or unauthorized retrieval. Coverage metadata MUST NOT reveal inaccessible record details.

The adapter owns native API calls, authentication, pagination and rate-limit handling. Shared application code owns range interpretation, context budgets, ordering, deduplication and source-block formatting. Both Slack channel history and thread replies MUST be proven accessible with the selected installation credentials before release. Validate current API/token/scope requirements during implementation; receiving mention events does not establish access to every required history type.

Proposed automatic-context defaults are at most 50 source messages and 8,000 characters of source text per turn, including attribution. Keep the thread root when available, then the most recent replies that fit; render selected records chronologically. Explicit summaries use configurable larger message/page/text limits. Document those limits and a retrieval deadline before release; never fetch unbounded history. Pagination and retries MUST respect the deadline and platform retry guidance.

Use message IDs and revision metadata to avoid replaying overlapping history or duplicating accepted turns and assistant responses already represented in the provider session. Track context inclusion per provider-session generation so reset/recreation does not suppress needed history. A cached high-water mark alone MUST NOT imply complete coverage across gaps. Re-fetch the selected bounded window to observe available edits/deletions; remove deleted records from host caches and replace stale versions. If previously included content cannot safely remain after deletion or an access change, rebuild a clean session from currently authorized context instead of claiming an append-only session has forgotten it. Do not promise immediate detection outside the fetched window.

Fetched records MUST be labeled as untrusted conversation data with source attribution, never instructions or permission grants. Apply requester visibility, response-audience checks and configured author exclusions before inclusion. Limit the MVP to the originating channel and its threads; reject cross-channel retrieval. Attachment metadata may be represented, but attachment contents MUST NOT be inferred or downloaded through text-history support.

When automatic retrieval is partial or unavailable, the assistant may answer from the current message, existing authorized session context and valid returned records, but MUST disclose missing coverage. A requested history summary MUST state its actual coverage and exclusions, include useful source links, and explicitly report unavailable or incomplete retrieval. Never invent missing discussion or present old session context as freshly retrieved history.

Example: Alice mentions the bot, Bob posts an unmentioned clarification, then Alice mentions the bot again. Bob's clarification MUST be eligible context for the second response, subject to visibility and budgets, without triggering a response when Bob posts it.

Use Socket Mode as the proposed first transport to avoid requiring a public inbound endpoint. Keep normalization separate from transport handling so an HTTP Events API receiver can be added later. Validate current Slack scopes, event subscriptions, acknowledgement requirements and retry behavior against official documentation during implementation. Store credentials in host configuration only.

Long responses MUST be split according to actual platform limits while preserving ordering and the same thread destination. Define explicit behavior for unsupported artifact output rather than claiming successful file delivery.

### CLI

The CLI creates synthetic channel and thread IDs and uses the same `ConversationService` as network adapters. Startup in CLI-only mode MUST NOT require a Discord token or instantiate a Discord client.

Illustrative interface, with final executable naming left to implementation:

```sh
assistant cli --channel local --thread refactor
assistant cli --channel local --thread smoke --message "hello" --json
assistant cli --provider fake --channel tests --thread case-1 --message "hello"
```

Interactive mode reuses the selected session and prints replies and progress. One-shot mode exits after completion; a new invocation with the same identity and configured store reuses that session. JSON mode emits a documented result/error schema on stdout and diagnostics/progress on stderr. Exit status MUST distinguish success from failure; cancellation MUST be observable.

CLI tests MUST support a fixture-backed `HistoryPort` to exercise shared selection, attribution, coverage and failure behavior without network credentials. Normal CLI operation may leave history retrieval unsupported while retaining provider session continuity.

The local principal comes from trusted local configuration. Channel/thread flags select local conversation identity only. Ctrl-C SHOULD request cancellation. Reset MUST require the selected session's reset capability. Tests MUST use isolated stores so they cannot reset or alter real conversations.

## 9. Suggested code organization

```text
src/application/          # conversation service and application operations
src/core/                 # identity, contracts, policies and feature selection
src/adapters/discord/     # event/command mapping and Discord host ports
src/adapters/slack/       # transport, event mapping and Slack delivery
src/adapters/cli/         # local identity, input and terminal/JSON output
src/extensions/           # context and tool features registered by the host
src/providers/            # existing provider implementations
src/composition/          # configuration, startup and dependency wiring
```

This is a target ownership model, not a requirement to move all files at once. Remove the `chunkForDiscord` dependency/re-export from the shared session facade and keep formatting with the adapter. Replace Discord-specific provider options with neutral host context, retaining compatibility wrappers while callers migrate.

## 10. Migration sequence

1. Capture Discord compatibility behavior with focused characterization tests, including legacy keys, authorization, shared/private context, `/chat` threading and output delivery.
2. Introduce neutral identity/contracts and configurable startup. Extract the turn service from existing orchestration with compatibility wrappers for Discord context and tools.
3. Add the CLI and fake provider as the first new consumer. Prove a complete turn works without Discord credentials, objects or SDK imports in the core. Do not create a separate CLI orchestration path.
4. Route Discord mentions and `/chat` through the service. Preserve existing optional extensions; remove duplicated orchestration after behavior tests pass.
5. Add Slack mention normalization, session mapping, durable retry handling, threaded text delivery and authorized channel/thread history retrieval. Exercise the shared history port with CLI fixtures, then validate both history types using the actual installation credentials in an authorized Slack test workspace.
6. Finish capability-dependent prompt/tool composition, documentation and startup/shutdown coverage. Release Slack as opt-in configuration.

Use small reviewable changes. New journal/session metadata SHOULD be additive so rollback can preserve legacy Discord bindings. Document how to drain accepted work before rollback; do not run old and new consumers against the same incoming events simultaneously.

## 11. Acceptance and validation

| Area | Required evidence |
| --- | --- |
| Boundary | Core runs with fake ports and no Discord/Slack objects; import checks prevent SDK coupling |
| Discord regression | Existing relevant suite plus characterization tests pass; session continuity and supported features preserved |
| Session isolation | Same native IDs across platforms/tenants/installations remain distinct; different Slack roots remain distinct; thread follow-ups reuse the correct session |
| Authorization | Unauthorized events never execute providers; forged tenant context and local identity impersonation fail; private context cannot enter shared sessions |
| Capabilities | Unsupported features are absent from prompts and inaccessible through host tools |
| Retry handling | Concurrent duplicate events admit one turn; restart recovery handles accepted/generated/interrupted states without silent model reruns |
| Ordering | Same-session turns serialize across all providers; separate sessions can progress independently; reset cannot race a running turn |
| Delivery | Failed sends retry stored output without regeneration; partial/uncertain delivery is observable; long text preserves ordering and destination |
| CLI | Interactive and one-shot modes work; JSON output is machine-readable; CLI-only startup needs no Discord credentials |
| Slack | Root mention, threaded mention, unmentioned reply that triggers no turn but becomes later context, denied event, duplicate event and disabled DM behavior verified |
| History context | Pre-bot discussion, thread root, intervening replies and root-mention channel context included under the correct scope; unrelated threads and later messages excluded |
| History coverage | Pagination, budgets, ordering, duplicate suppression, edit/delete handling, session reset/recreation, rate limits, unavailable/empty/partial results and summary source links verified |
| History access | Actual Slack credentials retrieve both history types; private-channel visibility, author exclusions, audience checks, cross-channel rejection and permission-revoked cache/session reuse tested |
| History requests | Last N, relative duration, after-message and actual previous-message selectors resolve correctly; ambiguous or unsupported intervals request clarification |
| Lifecycle | Provider failure, timeout, cancellation, queue overflow and shutdown release resources and produce truthful status |

Deterministic fake-provider tests verify orchestration and adapter contracts. Optional real-provider CLI smoke tests verify the shared application/provider path but do not prove Slack/Discord transport behavior. Separate platform smoke tests MUST verify event ingress and actual threaded delivery. Record actual test execution and any untested platform/provider combinations in implementation PRs.

Completion means Discord uses the shared path, Slack and CLI meet this scope, session/access isolation holds, relevant tests pass, and configuration plus extension instructions are documented. It does not mean Slack has full Discord feature parity.

## 12. Proposed defaults requiring review

- Slack uses explicit mentions, shared thread sessions and Socket Mode. Authorized channel/thread history enrichment and requested summaries are included in the first release; DMs remain deferred. Automatic context defaults to 50 messages and 8,000 source-text characters per turn, with coverage disclosed when limited.
- CLI uses an individually scoped local principal; no cross-platform impersonation or session sharing.
- Discord keeps its legacy session resolver for the initial release.
- One worker owns a durable turn journal initially; multi-worker deployment is rejected until distributed coordination exists.
- Configuration and data identity support tenant/installation namespacing from the start. Dynamic Slack OAuth installation management is a separate feature; initially use explicitly configured installations.

These defaults define the intended implementation; section 13 records current evidence and deviations.

## 13. Task-based deliverables and implementation evidence

The following tasks track the migration sequence. “Implemented” describes source changes; it does not mean all acceptance checks have passed. This remains an implementation draft until the blocked checks below are completed.

| Task | Deliverable | Acceptance criteria | Evidence / status |
| --- | --- | --- | --- |
| T1 | Preserve Discord session identity and characterize behavior | Discord regression, session isolation | Legacy key tests pass. Full existing Discord suite requires dependencies. |
| T2 | Normalize identity, capabilities, history and delivery contracts | Boundary, authorization, capabilities | `src/core/conversation.ts`; import-boundary and identity tests. |
| T3 | Shared turn lifecycle, durable journal, deduplication and ordering | Retry handling, ordering, delivery, lifecycle | `src/application/conversationService.ts`; duplicate, ordering, restart, ownership and delivery-failure tests. |
| T4 | CLI interactive, one-shot, JSON, reset and fake/real provider paths | CLI, boundary, session continuity | `src/adapters/cli/run.ts`; fake-provider process tests. Real-provider smoke check pending. |
| T5 | Route Discord mentions and chat through shared execution/delivery | Discord regression, session continuity | `src/adapters/discord/`; original handler exports retained. Preparation runs through the shared queue; platform features and legacy keys are preserved. Full regression checks pending. |
| T6 | Slack Socket Mode, explicit mentions and threaded text | Slack, session isolation, delivery | `src/adapters/slack.ts`; mocked mention, ignored event, retry and revocation checks. Live ingress pending. |
| T7 | Slack channel/thread history and requested summaries | History context, coverage, access, requests | Shared selection and Slack history port; root/intervening context, range, budget, paging-failure and access tests. Actual token access pending. |
| T8 | Platform-specific provider prompts/tools and composition | Capabilities, authorization, lifecycle | Transport context for all three providers; tool-list filtering plus host enforcement; CLI-only and Slack-only startup paths. Full provider regression checks pending. |
| T9 | Validation and operating instructions | All locally testable criteria | Commands and limitations below. Full type check/build blocked by unavailable npm registry. |
| T10 | Live deployment smoke checks | Actual Slack/Discord ingress, delivery, history credentials | Not run: no deployment credentials or authorized external chat writes in this session. |
| T11 | Draft PR and independent current-head review | Review findings addressed | Recorded in the PR and final delivery report. |

### Validation commands

Normal checkout validation (must run with dependencies available):

```sh
npm ci
npm run build
npm test
```

Dependency-free validation used in this workspace on Node 22.23.3:

```sh
node --experimental-transform-types --loader ./scripts/typescript-loader.mjs --test tests/conversationService.test.ts tests/adapterHistory.test.ts tests/slackAdapter.test.ts tests/adapterCli.test.ts tests/discordSessionKey.test.ts
```

All local TypeScript sources were also parsed with Node's `stripTypeScriptTypes` in transform mode. Parsing/emitting JavaScript is not TypeScript type checking. The npm installation attempt was blocked by sandbox network policy for `registry.npmjs.org`; no alternative registry was used to bypass that restriction. Existing SDK-dependent tests and real providers were not exercised.

The focused suite currently passes 29 tests, including separate adapter persistence, queued Discord reset acknowledgement, command-versus-mention authorization, recovered-output audience checks, long-thread sampling, edited mentions and confirmed deletions. The emitted JavaScript CLI adapter also passed a one-shot fake-provider smoke check. Tracked runtime JavaScript was emitted with Node transform mode; provider type-only imports were checked for runtime elision. A normal TypeScript build remains a release gate.

### Operator setup

Discord remains the default `AI_ASSISTANT_ADAPTER`. Select `slack` to run Slack in a separate process; each process owns its adapter journal. Set:

- `SLACK_APP_TOKEN`: host-only app credential for Socket Mode.
- `SLACK_BOT_TOKEN`: host-only bot credential for identity, membership checks and replies.
- `SLACK_TEAM_ID`: expected workspace identity; both bot and history credentials are checked against it.
- `SLACK_ALLOWED_CHANNELS` and `SLACK_ALLOWED_USERS`: required comma-separated allowlists.
- `SLACK_INSTALLATION_ID`: optional stable logical installation name, default `default`.
- `SLACK_HISTORY_TOKEN`: optional separate history credential where required by the installation; never sent to providers.
- `SLACK_EXCLUDED_CONTEXT_USERS`: optional comma-separated authors excluded from history.
- `AI_ASSISTANT_STATE_DIR`: host-owned journal/context directory; default `~/.config/ai-assistant/adapters`. Keep it outside provider-readable workspace paths and persist it across restarts.

Slack requires shared provider security mode. DMs, group DMs and externally/organization-shared channels are rejected pending a separate audience policy. The app must be a channel member, and current channel membership must include the requester. Changes to the checked audience invalidate retained provider context. Explicit allowlists are the initial Slack policy; general role/group grants are not implemented.

Configure Socket Mode and `app_mention` subscriptions, message posting and channel metadata/membership/history access in Slack. Verify the current scopes and token support for your installation rather than assuming that event receipt establishes history access. Primary references: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [channel history](https://docs.slack.dev/reference/methods/conversations.history/), [thread replies](https://docs.slack.dev/reference/methods/conversations.replies/). The implementation bounds requests and reports rate-limited/unavailable history; it does not promise full history on every turn.

CLI examples after building:

```sh
ai-assistant cli --provider fake --channel local --thread smoke --message hello --json
ai-assistant cli --channel local --thread work
ai-assistant cli --channel local --thread work --reset
```

The CLI principal comes from `AI_ASSISTANT_CLI_USER` or the operating-system account. Identity cannot be supplied through a user flag. Set `AI_ASSISTANT_CLI_ALLOW_RESET=false` to disable local reset. `PROVIDER` selects a real provider unless `--provider fake` is supplied. Real providers retain their existing credential and sandbox configuration. `/quit` exits interactive mode; `/reset` resets the selected session. JSON mode requires a one-shot message or reset.

### Recovery, rollout and limitations

- The journal uses an exclusive `owner.lock`. After a crash, an operator must first establish that the recorded process is stopped before removing only that stale lock and restarting. Never delete a live process's lock. A second worker fails closed.
- Accepted/running/delivering records found on restart become interrupted. They are not automatically rerun; delivery may already have occurred. Generated output can be redelivered on source retry without generating again. Uncertain delivery requires operator reconciliation. Automatic replay of unstarted accepted jobs is not implemented because adapter callbacks are reconstructed from the source event.
- Journals currently retain records until operator archival. Archive only after the source retry window, with the adapter stopped; retaining records preserves duplicate suppression. Automated retention cleanup is not implemented.
- Cancellation prevents queued generation or delivery and waits for an already-running provider to settle under its existing timeout. Immediate provider cancellation is not guaranteed; do not launch a replacement run until the old operation has stopped.
- Discord preparation now runs inside the shared session queue. New `/chat` threads are created after durable admission and their resolved session binding is persisted before execution. A crash during remote thread creation is marked interrupted rather than silently creating another thread. Discord acknowledgement/progress messages remain transport-owned.
- `chunkForDiscord` remains a compatibility export on the existing facade. New adapters import formatting directly; removing the public export would unnecessarily break existing consumers during migration.
- History changes are observed in bounded fetched windows. No immediate deletion detection outside those windows is promised. The initial Slack deployment supports explicitly configured installations, not dynamic OAuth installation management.
- Host-only fetched-record observations are kept separate from the smaller provider context selection. Deletions are inferred only from complete retrieval in the same history scope; dropping a reply from the context budget does not erase a session. Original requests and delivered replies have comparable content fingerprints. Recovered generated output must match its persisted generation audience before delivery.
- Real-provider session mappings and provider choices for CLI and Slack live under `AI_ASSISTANT_STATE_DIR/cli-provider-state/providers` and `AI_ASSISTANT_STATE_DIR/slack-provider-state/providers`, respectively. Their adapter journal locks protect each store owner. Discord retains its legacy provider-store paths. Do not run multiple processes for the same adapter/state directory.
- Slack progress UI is not yet implemented. Cancellation/status diagnostics are available to the host; operator-facing replay/reconciliation commands are not included.
- Full build, the existing Discord/provider suite, real-provider CLI use and live Slack/Discord smoke checks remain release gates. This draft must not be deployed as if those gates passed.

Roll out with Slack opt-in after those checks pass. Stop and drain the adapter before rollback. Preserve provider session stores and journals; do not run old and new consumers against the same event stream. Discord legacy keys remain unchanged.
