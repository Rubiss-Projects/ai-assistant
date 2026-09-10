# AI Assistant

A Discord bot for **GitHub Copilot**, **OpenAI Codex**, and **OpenCode**. Choose a default provider, then chat through mentions, DMs, or dedicated conversation threads. You can switch providers during a conversation without restarting the bot.

- Persistent conversations, isolated by user/channel or chat thread.
- Images, video, audio, text/code attachments, and downloadable files created by the agent.
- Discord history search and long-term server memory through natural requests.
- Model and reasoning controls, plus provider-specific tools and slash commands.
- User and admin access lists, scoped workspaces, and a Docker deployment for shared servers.

## Contents

- [Getting started](#getting-started)
- [Using the bot](#using-the-bot)
- [Scheduled tasks and named rights](#scheduled-tasks-and-named-rights)
- [Environment variable reference](#environment-variable-reference)
- [Access and security](#access-and-security)
- [Managing your installation](#managing-your-installation)
- [Development](#development)

## Getting started

First configure Discord and choose a provider. Then follow **one** installation path: [global npm install](#global-npm-install), [Docker](#docker), or [run from source](#run-from-source).

### 1. Configure Discord

1. Create an application with a bot user in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, enable **Message Content Intent** and copy the bot token (`DISCORD_TOKEN`). Under **General Information**, copy the Application ID (`DISCORD_APP_ID`).
3. In Discord, enable **Settings → Advanced → Developer Mode**. Right-click your server to copy its ID (`DISCORD_GUILD_ID`). You can copy channel and user IDs the same way.
4. In the Developer Portal, open **OAuth2 → URL Generator** and select the `bot` and `applications.commands` scopes. Select **View Channels**, **Send Messages**, **Send Messages in Threads**, **Create Public Threads**, **Read Message History**, **Attach Files**, and **Use Slash Commands**. Open the generated URL to invite the bot.

Slash commands are registered to the server named by `DISCORD_GUILD_ID`. All three Discord variables are required for registration.

Decide who can use the bot before starting it: when `DISCORD_ALLOWED_USERS` and `DISCORD_ADMIN_USERS` are both empty, everyone who can reach it can use public and administrative commands. See [Access and security](#access-and-security) for the permission rules.

### 2. Choose and authenticate a provider

Set `PROVIDER` to one of the following. Authenticate each provider you want to use, under the same operating-system user that runs the bot.

| `PROVIDER` | Backend | Authentication | Default model in this repo |
| --- | --- | --- | --- |
| `copilot` | GitHub Copilot SDK | `COPILOT_GITHUB_TOKEN` (preferred), `GH_TOKEN`, or a persisted CLI login with Copilot access | `claude-haiku-4.5` |
| `codex` | OpenAI Codex SDK | `OPENAI_API_KEY` or a persisted `codex login` | `gpt-5.6-sol` |
| `opencode` | OpenCode CLI | `opencode auth login` or the selected model provider's API key | OpenCode's configured default |

For native installs, OpenCode requires its CLI to be installed and discoverable (or set `OPENCODE_BIN`). Docker includes all three provider CLIs; [container login commands](#docker) are below.

Native video conversion also requires `ffmpeg` and `ffprobe` on `PATH`, with the `libsvtav1`, `libx264`, and `libx265` encoders. These are included in the Docker image.

### 3. Install and start

#### Global npm install

Requires Node.js 18+ and authentication for your chosen provider.

```bash
npm install -g --install-links github:Rubiss-Projects/ai-assistant
ai-assistant setup
ai-assistant start
```

The setup wizard writes `~/.ai-assistant/.env` and offers to register slash commands. Accept that step, or run `ai-assistant register` before starting. Add advanced settings directly to that file using the [environment reference](#environment-variable-reference).

For later configuration changes, edit `.env` directly. Rerunning `ai-assistant setup` rewrites it and removes settings outside the wizard's prompts, including provider tokens, attachment mode, and file limits. If you rerun setup, back up the file and restore those entries before restarting.

For automatic startup on Linux or WSL with systemd, see [Run as a service](#run-as-a-service).

#### Docker

Requires Docker with Compose. Clone the repo to get the Compose file and configuration template:

```bash
git clone https://github.com/Rubiss-Projects/ai-assistant.git
cd ai-assistant
cp .env.example .env
```

Edit `.env`: fill in the Discord credentials, set `PROVIDER`, and configure access lists and provider authentication. For example, a Codex deployment using an API key needs these values alongside the template's other settings:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_APP_ID=your_application_id
DISCORD_GUILD_ID=your_server_id
PROVIDER=codex
OPENAI_API_KEY=your_api_key
AI_ASSISTANT_SECURITY_MODE=shared
DISCORD_ATTACHMENT_MODE=text
```

Pull the image, then start the bot:

```bash
docker compose pull
docker compose up -d
docker compose logs -f assistant
```

If you use CLI login instead of a token or API key, run the matching command after pulling the image and before starting the bot:

```bash
docker compose run --rm assistant copilot login
docker compose run --rm assistant codex login
docker compose run --rm assistant opencode auth login
```

The entrypoint registers the current slash commands on each container start unless `REGISTER_COMMANDS_ON_START=false`. Releases publish `ghcr.io/rubiss-projects/ai-assistant:<version>`; the included Compose file uses `latest`.

Compose loads the project's host-side `.env` and passes its tokens and API keys into the container environment. Persisted CLI logins, session state, and retained agent files live in the Docker-managed `assistant-data` volume; provider workspaces are under `/data/workspaces`. The container runs as an unprivileged user with a read-only image filesystem, dropped Linux capabilities, and no host bind mounts. See [Container isolation](#container-isolation) for the boundary this provides.

#### Run from source

Requires Node.js 18+ and authentication for your chosen provider.

```bash
git clone https://github.com/Rubiss-Projects/ai-assistant.git
cd ai-assistant
npm install
cp .env.example .env
```

Fill in the Discord and provider settings in the repository's `.env`, then register commands and start:

```bash
npm run register
npm start
```

## Using the bot

### Conversations and sessions

Use `/ask <prompt>` for a private, one-shot answer or `/chat <message>` for an ongoing conversation:

| Where you use `/chat` | What happens |
| --- | --- |
| Server channel | Creates a public thread named `{Provider}: {your message}`, with its own conversation. |
| Existing thread | Continues that thread's conversation. |
| DM | Responds inline in your persistent DM session. |

You can also mention the bot in a visible channel, or send a message without a mention in a channel listed in `DISCORD_FREE_CHANNELS`. Bot-owned chat threads respond without a mention. Ordinary channel conversations are isolated by user and channel; a bot-owned thread shares one session among its participants.

Mentions and free-channel messages include nearby conversation. A reply mentioning the bot also includes the referenced message and its surroundings.

Long tasks send periodic “still working” messages (every minute by default). Each provider has a one-hour hard timeout by default. At that limit, the bot cancels or terminates the run and waits up to five seconds for cancellation confirmation.

### Artifact and media tools

The built-in `artifact_tools` MCP server is available to all three providers, including in shared mode.

| Tool | Behavior |
| --- | --- |
| `fetch_artifact` | Downloads a public HTTP(S) file URL, or resolves a Discord message's attachments, embedded media, and links. One candidate downloads immediately; multiple candidates are returned for selection using `candidate_id`. |
| `transcode_video` | Converts a local video to `av1`, `h264`, or `hevc` in MP4 using FFmpeg software encoding. Returns a decoded, verified local output. |
| `attach_file` | Validates and copies a finished file, freezes its bytes, and registers it for the current Discord response. Returns `ready` or an actionable error while the agent can still correct its output. |

### Switch providers, models, and reasoning

Every session starts with the provider selected by `PROVIDER`. Use the following slash commands to inspect or change it:

```text
/provider list
/provider set codex
/provider current
```

A change inside a thread applies to that thread; a change in a channel or DM applies to that user's session. Provider choices survive restarts. Each provider keeps separate history for the same Discord session: switching to a provider for the first time starts fresh, and switching back resumes its earlier history. Conversation history is not transferred between providers.

Use `/model` to choose a model and `/reasoning` to control reasoning effort on supported providers. Commands that change providers, models, or reasoning require admin access.

### Search and memory

Ask naturally to “search this channel for the beach plans” or “search across the server.” The bot generates related queries, gathers indexed Discord messages, ranks the results, and returns source links. Searches respect the requester's channel access; the default pools are 200 candidates and 50 messages supplied to the answering agent.

Say “remember this” or “put this in memory” to save information for the server, and “forget the cheese agreement” to remove matching records. Relevant memories are recalled in later conversations. Replied-to contract summaries are resolved to their original messages so complete text and source links are preserved. Each memory keeps its source channel and is recalled only while the requester can still read that channel.

### Slash commands

| Command | Description | Copilot | Codex | OpenCode |
|---------|-------------|:---:|:---:|:---:|
| `/ask <prompt>` | One-shot question — no session history, private reply | ✅ | ✅ | ✅ |
| `/chat <message>` | Start/continue a persistent conversation in a thread | ✅ | ✅ | ✅ |
| `/reset` | Clear your conversation history | ✅ | ✅ | ✅ |
| `/model list/set/current` | List models, switch model, show current | ✅ | ✅ | ✅ |
| `/provider list/set/current` | Switch the active AI provider per session | ✅ | ✅ | ✅ |
| `/reasoning list/set/current` | Reasoning effort control | ✅ | ✅ | ⚠️ |
| `/status` | Show auth status and CLI version | ✅ | ✅ | ✅ |
| `/history [count]` | Show your recent exchanges | ✅ | ✅ | ✅ |
| `/agent list/current/select/deselect` | Custom agent management | ✅ | ⚠️ | ⚠️ |
| `/mode get/set` | Session mode (interactive/plan/autopilot) | ✅ | ⚠️ | ⚠️ |
| `/compact` | Compact session context | ✅ | ⚠️ | ⚠️ |
| `/fleet` | Start fleet mode | ✅ | ⚠️ | ⚠️ |
| `/plan read/update/delete` | Session plan management | ✅ | ⚠️ | ⚠️ |
| `/workspace list/read/create` | Workspace file management | ✅ | ⚠️ | ⚠️ |
| `/mcp list/enable/disable/workspace` | MCP server management | ✅ | partial | ⚠️ |
| `/servers`, `/leave` | Server management | ✅ | ✅ | ✅ |

`✅` = supported · `⚠️` = replies "provider does not support this" · `partial` = listing works, injection not

Support also depends on the configured security mode. Copilot's additional features include custom agents, plans, workspace commands, and user-scope skills loaded from `~/.agents/skills` at session start.

## Scheduled tasks and named rights

Authorization is centralized in `src/common/accessPolicy.ts`. Existing
`DISCORD_ALLOWED_USERS` and `DISCORD_ADMIN_USERS` behavior remains compatible,
including the open-admin fallback for existing commands. Optional
`DISCORD_RIGHTS_FILE` JSON grants add named capabilities to individual Discord
users or guild-scoped Discord roles. The file is operator-controlled, must be
outside agent workspaces, and is validated at startup; restart to reload changes.
See [`rights.example.json`](rights.example.json) for a complete example with
placeholder IDs. Discord's Administrator permission does **not** automatically
grant bot administration.

| Capability | Operations |
| --- | --- |
| `chat.use` | Conversations and existing public slash actions |
| `session.configure` | Model, reasoning, provider, agent, and mode changes |
| `workspace.manage` | Workspace operations and explicit `/ask`/`/chat` workspaces |
| `mcp.manage` | MCP configuration |
| `bot.manage` | Global bot administration: servers, leave, status, fleet |
| `schedule.message.create` | Create or modify fixed-message tasks |
| `schedule.ai.create` | AI tasks; additionally requires explicit bot administration |
| `schedule.manage.own` | Inspect and manage owned tasks |
| `schedule.manage.guild` | Inspect and manage all tasks in the granted guild |

The `member` preset grants `chat.use`. The `scheduler` preset adds
`schedule.message.create` and `schedule.manage.own`. The `server-admin` preset
adds `schedule.manage.guild`; it grants no host, provider, or cross-server
administration. The global `bot-admin` preset grants all capabilities and may
only be assigned to user IDs. Role grants require `guildId`. Task edits,
resumes, manual runs, and delivery retries also require creation rights for that
task type: a server schedule manager cannot rewrite or execute an AI task owned
by a bot administrator. No in-Discord rights editor is exposed.

For an admin-only installation, set `DISCORD_ADMIN_USERS` explicitly and
`SCHEDULES_ENABLED=true`. For a scheduling whitelist, additionally grant the
`scheduler` preset to selected user IDs or a Discord role. An empty admin list
never grants scheduling, even if legacy commands allow everybody. Scheduling
rights are additive to the existing lists; set an explicit admin list if you
want other configuration commands restricted too.

```text
/schedule create kind:message channel:#reminders content:Submit your availability cron:0 9 * * 5 timezone:America/New_York
/schedule create kind:ai channel:#daily-updates content:Summarize the recent discussion cron:0 9 * * 1-5 timezone:America/New_York provider:codex model:<model-id> context_messages:100
```

Creation shows the interpreted schedule and the next three occurrences.
`/schedule list` shows manageable tasks in the current guild. Use
`/schedule inspect id:<id>` for the prompt/message, ownership, saved settings,
pause reason, recent runs, and delivered-message links. `/schedule edit`,
`pause`, `resume`, `delete`, and `run-now` operate on that ID. Delete also removes
the task's run history. Configuration responses are ephemeral. A guild schedule
manager can inspect all scheduled prompts in their guild, so grant that role
only to users trusted with those prompts.

Only ordinary guild text channels are supported initially; DMs, threads, forum
containers, natural-language schedule creation, and one-time tasks are deferred.
Cron accepts five fields (minute, hour, day of month, month, weekday) and requires
an explicit IANA timezone. Local schedules use cron-parser's daylight-saving
semantics: the UTC execution time changes with the local clock. Use UTC when
fixed UTC intervals matter; inspect the preview around clock changes. A runtime
minimum interval also prevents closely spaced executions, including manual runs.

Fixed-message tasks make no provider call. AI tasks require an explicit saved
model, use the selected provider (or the bot's configured provider at creation),
and optionally save a reasoning effort. They start with a fresh session and a
separate temporary workspace on every run. Provider-wide security, system prompt,
and integration configuration still apply; this is not a new tool sandbox.
For that reason, AI scheduling remains restricted to explicit bot administrators.
Scheduled AI runs use at most `SCHEDULE_AI_TIMEOUT_MS`, or the provider's shorter
configured inference timeout, plus its existing cancellation grace period.

AI context is opt-in (`context_messages:0` by default, maximum 100 recent messages,
40,000 characters). Only non-bot messages from the destination channel whose
authors are allowed to use the bot are included. No conversation history or
server-wide memory is automatically reused. Host-provided Discord attachment
lookups are restricted to that same destination, and linked private channels
cannot be resolved through this callback. Every run checks the owner's current
guild membership, role grants, and owner/bot channel permissions before execution
and before each outbound message. Revoked access pauses the task. Restart after
environment or rights-file changes so the new policy applies. All scheduled
posts suppress automatic user, role, and everyone mentions.

Schedules and run history live in
`~/.config/ai-assistant/schedules.sqlite` (inside the existing `assistant-data`
volume in Docker). Back up the database consistently with its WAL, or stop the
bot before copying it. SQLite transactional claims and a 60-second scheduler
lease allow one active scheduler per database. An unclean restart may need to
wait for that lease to expire. A stale worker is checked before delivery.

Missed occurrences after downtime are skipped. Tasks do not overlap, and full
worker capacity skips occurrences rather than building an unbounded backlog.
Defaults are 15 minutes between starts, 10 tasks per owner across servers, 50 per
guild, two concurrent runs, and a 10-minute AI inference limit; the `SCHEDULE_*`
variables in `.env.example` configure these bounds. Paused tasks count toward
quotas. Three consecutive generation failures pause a task.

Generation output and delivery state are recorded separately. Successful runs
retain message IDs but discard output payloads. Recent ordinary run history is
bounded to 20 per task; unresolved delivery failures and uncertain outcomes are
retained for inspection. A definitely rejected Discord send can be retried with
`/schedule retry-delivery id:<id> run_id:<run-id>`; it sends only the remaining
parts and does not repeat AI work. Editing a task invalidates old delivery retries.
An ambiguous send, interrupted inference, or unconfirmed cancellation pauses the
task for inspection; it is never automatically replayed. Exactly-once Discord
delivery is not guaranteed, including the crash window between a successful send
and saving its message ID. Pausing or editing suppresses pending output, but cannot
recall a message already being sent or undo provider tool effects.

## Environment variable reference

The tables below cover every setting read or explicitly passed to providers by this repository, including advanced settings missing from the starter template. Provider CLIs can have additional configuration of their own; in `unrestricted` mode they inherit the full process environment.

### Where configuration lives

| Installation | Configuration file | How it is loaded |
| --- | --- | --- |
| Global CLI | `~/.ai-assistant/.env` | `setup` writes it; `start` and `register` change into that directory before loading it. |
| Source checkout | `.env` in the repository | `npm start` and `npm run register` load it from the working directory. |
| Docker Compose | `.env` beside `compose.yaml` | Compose passes entries into the container. Its explicit `environment` entries override the same keys in `.env`. |

For native foreground runs, variables already set in the launching environment take precedence over `.env`. Update or unset an exported value before relying on a change in the file.

Two native-startup exceptions are `COPILOT_MODEL` and `MCP_CONFIG_PATH`: the application reads them before loading `.env`. Set them in the launching environment before `npm start` or `ai-assistant start`. Docker and systemd populate the environment before application startup, so their configured values are available in time.

Restart native processes after changing configuration. For Docker, use `docker compose up -d` to apply changes; a container restart alone does not reload Compose's environment. Existing Copilot and Codex sessions may need `/reset` after system-prompt changes.

Defaults below describe behavior when a setting is absent, with template, wizard, and container overrides called out explicitly. `~` in a documented default means the operating-system user's home; use absolute paths when setting path overrides yourself. Time values are milliseconds and size values are bytes.

### General settings and security

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `PROVIDER` | `copilot`; accepts `copilot`, `codex`, `opencode` | Selects the default AI backend. `/provider set` overrides it for a session. |
| `AI_ASSISTANT_CONFIG_DIR` | `~/.ai-assistant`; container: `/data` | Changes the CLI's configuration directory. Set in the launching environment **before** invoking the CLI; placing it only inside the file it is meant to locate does not redirect loading. Does not relocate session stores. |
| `AI_ASSISTANT_SYSTEM_PROMPT` | Unset | Adds persistent operator instructions to every provider. Quote text containing spaces or `#` in `.env`. |
| `AI_ASSISTANT_SYSTEM_PROMPT_FILE` | Unset | Reads operator instructions from a UTF-8 file, taking precedence over inline text. Relative paths resolve from the bot's working directory. Unreadable files cause an error. In Docker, keep the file under `/data`. |
| `AI_ASSISTANT_SECURITY_MODE` | `unrestricted` if absent; template/wizard: `shared` | `shared` isolates credentials and scopes provider tools; `unrestricted` gives providers the operator's inherited capabilities. Invalid values stop startup. See [Provider security](#provider-security). |
| `AI_ASSISTANT_ENABLE_SITES` | `false`; accepts `true`, `false` | In shared mode, enables the Codex Sites connector and scoped source-push network access to create, update, and publish through the logged-in ChatGPT account. Other apps remain restricted and destructive connector actions remain blocked. |
| `AI_ASSISTANT_WORKSPACE_ROOT` | Working directory in shared mode; wizard: `<config dir>/workspaces`; Compose: `/data/workspaces` | Sets the enforced root for provider file access in shared mode. Ignored in unrestricted mode. Compose explicitly sets this value, so changing it there requires editing `compose.yaml`. |
| `REGISTER_COMMANDS_ON_START` | `true` in the container entrypoint | Registers guild slash commands before the container starts the bot. Set `false` to skip; only the exact value `true` enables registration. Has no effect on native startup. |

For a short custom prompt:

```env
AI_ASSISTANT_SYSTEM_PROMPT="Use a playful tone, but be concise."
```

For a longer prompt, set `AI_ASSISTANT_SYSTEM_PROMPT_FILE` to a file readable by the bot, such as `/data/system-prompt.txt` in Docker.

### Discord

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `DISCORD_TOKEN` | Required | Bot token used to connect to Discord and register commands. |
| `DISCORD_APP_ID` | Required for registration | Discord Application ID whose slash commands are registered. |
| `DISCORD_GUILD_ID` | Required for registration | Server ID receiving the guild slash commands. The registration script does not fall back to global registration. |
| `DISCORD_FREE_CHANNELS` | Empty; comma-separated channel IDs | Channels where allowed users can chat without mentioning the bot. |
| `DISCORD_ALLOWED_USERS` | Empty; comma-separated user IDs | Restricts ordinary messages and public slash actions. Empty allows everyone; explicit admins can also invoke public slash actions. |
| `DISCORD_ADMIN_USERS` | Falls back to `DISCORD_ALLOWED_USERS` | Comma-separated user IDs allowed to invoke administrative slash actions. If both lists are empty, everyone has admin access. Does not by itself grant access to ordinary messages. |
| `DISCORD_ATTACHMENT_MODE` | `native`; accepts `native`, `text` | `native` stages attachments in the turn's workspace and supplies file paths; binary files are never inlined as text. `text` embeds text/code uploads as untrusted text and deletes temporary uploads before the provider runs; binary uploads and video processing are unavailable. Images remain vision inputs in both modes. |
| `DISCORD_SEARCH_CANDIDATE_LIMIT` | `200`; integer ≥ `25` | Maximum unique indexed search candidates gathered across generated queries. Invalid or smaller values use the default. |
| `DISCORD_SEARCH_CONTEXT_LIMIT` | `50`; integer ≥ `10` | Maximum ranked search messages supplied to the answering agent. Invalid or smaller values use the default. |
| `DISCORD_MEMORY_RECALL_LIMIT` | `5`; integer ≥ `1` | Maximum relevant durable memories included in a response. Invalid or smaller values use the default. |

### Run timing and output files

Provider timing and progress settings require integer values of at least `10`; invalid or smaller values use the default. Setting `0` does not disable progress updates or timeouts. Media timing and file limits have the bounds listed below.

| Variable | Default | What it does |
| --- | --- | --- |
| `AI_PROGRESS_INTERVAL_MS` | `60000` (1 minute) | Interval between progress messages during long runs, for all providers. |
| `AI_CANCELLATION_GRACE_MS` | `5000` (5 seconds) | How long to wait for a provider to confirm cancellation after a timeout. |
| `COPILOT_TIMEOUT_MS` | `3600000` (1 hour) | Hard limit for a Copilot run; the active run is aborted on timeout. |
| `CODEX_TIMEOUT_MS` | `3600000` (1 hour) | Hard limit for a Codex run; the active run is cancelled on timeout. |
| `OPENCODE_TIMEOUT_MS` | `3600000` (1 hour) | Hard limit for an OpenCode run; its child process is terminated on timeout. |
| `AI_INPUT_ATTACHMENT_MAX_BYTES` | `104857600` (100 MiB) | Per-file limit for incoming uploads and URL downloads. Requires an integer from `1` to `536870912` (512 MiB); invalid values raise an error. |
| `AI_MEDIA_TIMEOUT_MS` | `300000` (5 minutes) | Deadline for software video conversion. Positive integer, capped at `900000` (15 minutes); invalid values use the default. |
| `AI_OUTPUT_ATTACHMENT_MAX_BYTES` | `10485760` (10 MiB) | Maximum size of each agent-created response attachment, also bounded by the total response limit. |
| `AI_OUTPUT_ATTACHMENT_MAX_TOTAL_BYTES` | `10485760` (10 MiB) | Maximum combined attachment bytes retained for one response; hard cap `104857600` (100 MiB). |
| `AI_OUTPUT_ATTACHMENT_MAX_COUNT` | `10` | Maximum agent-created attachments per response; hard cap `10`. |

### GitHub Copilot

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | Unset; persisted CLI login | Authenticates with a GitHub account that has Copilot access. Takes precedence over `GH_TOKEN`. |
| `GH_TOKEN` | Unset | Fallback token when `COPILOT_GITHUB_TOKEN` is absent or blank. |
| `COPILOT_MODEL` | `claude-haiku-4.5` | Default Copilot model ID. For native foreground runs, set it in the launching environment; `.env` is loaded too late for this setting. |
| `COPILOT_HOME` | `~/.copilot` in shared mode | Sets Copilot's base directory in shared mode and is passed to its process for configuration/login state. |
| `GH_CONFIG_DIR` | CLI-defined | Optional GitHub CLI configuration directory passed to Copilot in shared mode. |

### OpenAI Codex

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | Unset; persisted Codex CLI login | Authenticates Codex with an API key. Also passed to OpenCode when using an OpenAI model provider. |
| `OPENAI_BASE_URL` | SDK default | Overrides the OpenAI API endpoint used by Codex, for example `https://api.openai.com/v1`. |
| `CODEX_MODEL` | `gpt-5.6-sol` | Default Codex model ID. |
| `CODEX_REASONING_EFFORT` | `low`; accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Default Codex reasoning effort. Invalid values raise an error; model support may vary. |
| `CODEX_HOME` | `~/.codex` | Codex configuration/login directory, also used to locate its model cache and generated images. |
| `CODEX_EXECUTABLE_PATH` | SDK executable; image: `/usr/local/lib/codex/bin/codex` | Overrides the Codex executable used by the SDK. The image sets this to its bundled runtime. |
| `CODEX_MAX_INLINE_ATTACHMENT_BYTES` | `200000` | Maximum bytes per non-image attachment read as text by the Codex adapter; positive integer, capped at `1000000`. Oversized attachments produce an error. |

### OpenCode and model provider keys

The following API keys are explicitly allowed into the OpenCode child process in shared mode. Set the key for the model provider you use, or use a persisted CLI login. `OPENAI_API_KEY` is listed in the Codex table above.

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `OPENCODE_MODEL` | OpenCode's configured default | Selects a model in `provider/model` format, for example `openrouter/anthropic/claude-sonnet-4.5`. |
| `OPENCODE_BIN` | Known npm install locations, then `opencode` on `PATH` | Overrides the OpenCode executable path. |
| `ANTHROPIC_API_KEY` | Unset | API key for OpenCode's Anthropic provider. |
| `OPENROUTER_API_KEY` | Unset | API key for OpenCode's OpenRouter provider. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Unset | Google model provider API key passed to OpenCode. |
| `GEMINI_API_KEY` | Unset | Gemini API key passed to OpenCode; interpretation depends on the selected provider. |
| `GROQ_API_KEY` | Unset | API key for OpenCode's Groq provider. |
| `MISTRAL_API_KEY` | Unset | API key for OpenCode's Mistral provider. |
| `COHERE_API_KEY` | Unset | API key for OpenCode's Cohere provider. |
| `XAI_API_KEY` | Unset | API key for OpenCode's xAI provider. |
| `OPENCODE_DISABLE_AUTOUPDATE` | Forced to `1` by the bot | Disables CLI auto-updates for each OpenCode child process. Operator values are overwritten. |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | Forced to `1` in shared mode | Prevents repository configuration from weakening OpenCode's generated security policy. In unrestricted mode, an existing value is inherited. |
| `OPENCODE_CONFIG_CONTENT` | Generated by the bot in shared mode | Supplies OpenCode's inline security policy in shared mode, overriding operator values. In unrestricted mode, existing configuration is preserved; the bot adds its artifact MCP tools when starting a turn. |

### MCP

| Variable | Default | What it does |
| --- | --- | --- |
| `MCP_CONFIG_PATH` | `~/.config/Code/User/mcp.json` | Overrides the global MCP file (`mcpServers` key). Workspace `.vscode/mcp.json` entries (`servers` key) win on duplicate names. Provider and security-mode support governs injection. For native foreground runs, set it in the launching environment; `.env` is loaded too late. |
| `MCP_INPUT_*` | Unset | Resolves `${input:id}` placeholders in MCP configuration. Uppercase the ID and replace hyphens with underscores: `${input:grafana-service-account-token}` uses `MCP_INPUT_GRAFANA_SERVICE_ACCOUNT_TOKEN`; `${input:portainer-api-token}` uses `MCP_INPUT_PORTAINER_API_TOKEN`. Servers with unresolved inputs are skipped. |
| `AI_ARTIFACT_BRIDGE_URL` | Generated by the bot | Internal endpoint supplied to the bot-launched artifact MCP adapter. Do not configure manually. |
| `AI_ARTIFACT_BRIDGE_TOKEN` | Generated by the bot | Internal authentication token supplied to the artifact MCP adapter for its provider session. Do not configure manually. |

### Inherited operating-system and runtime variables

These are advanced runtime inputs, usually supplied by the operating system. The bot does not assign defaults unless noted. Shared mode passes the common runtime variables below to provider processes; Codex uses a separate, narrower environment for local shell commands. XDG and GitHub configuration variables are provider-specific. The bot's own session stores remain under `~/.config/ai-assistant` regardless of XDG overrides.

| Variable | What it does / scope |
| --- | --- |
| `HOME` | Home-directory context on POSIX; also used to locate OpenCode's npm installation and Copilot's shared-mode base directory. Compose sets `/data` for the bot; Codex overrides it with the selected working directory for shared-mode local commands. |
| `USERPROFILE` | Windows home-directory context; fallback for Copilot's shared-mode base directory. Codex sets it to the selected working directory for shared-mode local commands on every platform. |
| `HOMEDRIVE` | Windows home drive passed to provider processes. |
| `HOMEPATH` | Windows home path passed to provider processes. |
| `APPDATA` | Used by the bot on Windows to look for OpenCode in the global npm installation. |
| `PATH` | Executable search path. The image includes the bundled Codex runtime and provider binaries. |
| `SYSTEMROOT` | Windows system directory context passed to providers. |
| `WINDIR` | Windows installation directory passed to providers. |
| `COMSPEC` | Windows command-interpreter path passed to providers. |
| `PATHEXT` | Windows executable extensions used during command lookup. |
| `TEMP` | Temporary-directory hint; Codex local commands use a private per-session directory in shared mode. |
| `TMP` | Alternative temporary-directory hint, with the same Codex override. |
| `TMPDIR` | POSIX temporary-directory hint, with the same Codex override. |
| `LANG` | Default locale passed to providers. |
| `LC_ALL` | Locale override passed to providers. |
| `LC_CTYPE` | Character-handling locale passed to providers. |
| `TERM` | Terminal type passed to providers. |
| `NO_COLOR` | Color-output preference passed to providers. |
| `HTTP_PROXY` | HTTP proxy configuration passed to provider processes; support depends on the CLI. |
| `HTTPS_PROXY` | HTTPS proxy configuration passed to provider processes. |
| `ALL_PROXY` | General proxy configuration passed to provider processes. |
| `NO_PROXY` | Hosts excluded from proxy use by supporting clients. |
| `NODE_EXTRA_CA_CERTS` | Additional certificate-authority file for Node-based clients. |
| `SSL_CERT_FILE` | Certificate-authority bundle path for supporting clients. |
| `SSL_CERT_DIR` | Certificate-authority directory for supporting clients. |
| `XDG_CONFIG_HOME` | Configuration base directory passed to Copilot and OpenCode in shared mode. |
| `XDG_DATA_HOME` | Data base directory passed to Copilot and OpenCode in shared mode. |
| `XDG_CACHE_HOME` | Cache base directory passed to Copilot and OpenCode in shared mode. |
| `XDG_STATE_HOME` | State base directory passed to OpenCode in shared mode. |
| `SUDO_USER` | Preferred account name when the CLI generates a systemd service. |
| `USER` | Service account fallback when `SUDO_USER` is absent; falls back to `root` if neither exists. |
| `NODE_ENV` | Set to `production` in the container image for runtime dependencies; the bot has no separate behavior switch for it. |

## Access and security

### Discord permissions

`DISCORD_ALLOWED_USERS` controls ordinary messages and public slash actions. `DISCORD_ADMIN_USERS` controls administrative slash actions; listed admins can also invoke public slash actions. To let an admin send ordinary messages when the allowlist is nonempty, include them in `DISCORD_ALLOWED_USERS` too.

When the admin list is empty, admin access falls back to the allowed-user list. When both are empty, everyone has both levels of access.

| Access level | Slash actions |
| --- | --- |
| Public | `/ask`, `/chat`, `/reset`, `/history`, `/compact`, all `/plan` actions, and `list`/`current`/`get` under `/model`, `/reasoning`, `/provider`, `/agent`, and `/mode`. |
| Administrative | `/model set`, `/reasoning set`, `/provider set`, `/agent select/deselect`, `/mode set`, all `/workspace` and `/mcp` actions, `/servers`, `/leave`, `/status`, and `/fleet`. Supplying `workspace` to `/ask` or `/chat` also requires admin access. Unknown commands/subcommands default to admin-only. |

Mention-only behavior determines when the bot replies; it does not restrict what tools a permitted user can invoke. Discord search also requires **Read Message History** and **Message Content Intent**. For shared bots, use `DISCORD_ATTACHMENT_MODE=text` to keep non-image uploads out of the agent's executable file inputs.

### Provider security

| `AI_ASSISTANT_SECURITY_MODE` | Intended use | Behavior |
| --- | --- | --- |
| `shared` | Servers with multiple users | Isolates bot secrets, restricts external mutations, and scopes file access to the assigned workspace. |
| `unrestricted` | Private servers whose users are trusted as the operator | Inherits the operator's credentials, connected apps, filesystem access, and provider capabilities. |

The template and setup wizard select `shared`. If the variable is absent, the bot uses `unrestricted` and logs a startup warning. Invalid mode values stop startup.

In shared mode, provider processes receive an explicit environment allowlist that excludes Discord credentials and MCP input secrets. Each adapter enforces additional restrictions:

- **Copilot** uses its `empty` mode with scoped file/search/web tools, read-only external MCP calls, and the host-owned artifact tools. Arbitrary shell, external mutating MCP calls, repository-defined MCP processes, and file access through workspace symlinks are blocked.
- **Codex** retains local shell, build, and test support inside its filesystem permissions. Local commands have no network access unless Sites is enabled, which allows source pushes only to `git.chatgpt-team.site` through a proxy. Its shell gets a separate environment without provider credentials and a private temporary directory. Hosted web search and allowed connectors use separate controls. Connected apps default off except known read-only GitHub repository tools; mutating and newly introduced connector tools remain disabled.
- **OpenCode** uses a permission policy that denies tools unless explicitly allowed. Plugins, shell execution, content-wide grep, sensitive paths, and access outside the workspace are blocked.

`AI_ASSISTANT_ENABLE_SITES=true` adds a Codex-only exception to shared mode: Discord users can create, update, and publish Sites as the logged-in ChatGPT account. It permits workspace-root `.openai` metadata and stages current site files in a fresh temporary Git repository; existing `.git` directories and history remain blocked. Other apps remain restricted and destructive connector actions remain blocked. In unrestricted mode, Sites follows the operator's normal Codex configuration.

Read-only connectors can still expose repository contents, and permitted users can consume model quota. Set the Discord access lists to match the audience you trust with those capabilities. Provider tool permissions are separate from conversational instructions.

### Container isolation

The included Compose deployment mounts only the Docker-managed `/data` volume. Shared-mode provider tools are rooted at `/data/workspaces`, outside the adjacent provider login and session state. CLI logins persist in the volume; host credentials are not automatically inherited.

Container networking remains available for Discord, model APIs, and hosted tools. Provider restrictions can independently deny network access to local agent commands.

Keep the provided isolation intact for a shared bot: host bind mounts, the Docker socket, privileged mode, or host networking can weaken the boundary. Docker and the host kernel remain part of that boundary and should be kept patched.

## Managing your installation

### Run as a service

On Linux or WSL with systemd, install the service after completing global CLI setup:

```bash
ai-assistant install-service
sudo systemctl start ai-assistant
sudo journalctl -u ai-assistant -f
```

The installer enables startup on boot; the service restarts on failure. After changing configuration, run `sudo systemctl restart ai-assistant`.

### Update

Use the commands for your installation method, then restart the running bot. Register slash commands again after command changes.

| Installation | Update | Register commands |
| --- | --- | --- |
| Global npm | `npm install -g --install-links github:Rubiss-Projects/ai-assistant` | `ai-assistant register` |
| Source checkout | `git pull` followed by `npm install` | `npm run register` |
| Docker | `docker compose pull` followed by `docker compose up -d` | Automatic on start unless disabled; manually use `docker compose run --rm assistant node /app/dist/scripts/register-commands.js`. |

`ai-assistant update` prints the npm update command; it does not install the update. For a native foreground process, stop it and run the start command again. For systemd, run `sudo systemctl restart ai-assistant` after updating.

### Persistent data

| Data | Native location | Docker location |
| --- | --- | --- |
| CLI configuration | `~/.ai-assistant/.env` or the configured CLI directory | Values passed from the project `.env` |
| Provider selections, session mappings, server memories | `~/.config/ai-assistant/` | `/data/.config/ai-assistant/` |
| Provider credentials and provider-owned session state | Provider home/configuration directories | Provider directories within `/data` |
| Agent workspaces and retained output files | Configured workspace root in shared mode | `/data/workspaces/` |

`.env` is git-ignored. Provider CLI logins are stored in their own directories, so credentials are not limited to `.env`.

### Uninstall

For a global npm install, first stop and remove the systemd service if you installed it:

```bash
sudo systemctl stop ai-assistant
sudo systemctl disable ai-assistant
sudo rm /etc/systemd/system/ai-assistant.service
sudo systemctl daemon-reload
```

Then remove the package:

```bash
npm uninstall -g ai-assistant
```

For Docker, `docker compose down` removes the containers while retaining the data volume. Add `--volumes` only if you intend to delete persisted CLI logins, sessions, memories, and agent files; the host-side `.env` and its secrets remain. Native configuration and state also remain after uninstall; remove the directories listed above only if you intend to discard that data.

## Development

After [installing from source](#run-from-source), use `npm run build` to compile TypeScript and `npm test` to run the test suite.

### Project structure

```
src/
  index.ts              # Entry point — loads .env, starts bot
  bot.ts                # Discord client, command routing, message & thread handling
  commands.ts           # Slash command definitions (unified command set)
  cli.ts                # ai-assistant CLI (setup/start/register/install-service/update)
  sessionManager.ts     # Facade — routes each session to its active provider
  providers/
    types.ts            # Provider interface + shared types + UnsupportedError
    copilot.ts          # Copilot SDK adapter (GitHub Copilot)
    codex.ts            # Codex SDK adapter (OpenAI Codex)
    opencode.ts         # OpenCode CLI adapter
    index.ts            # createProvider() factory (reads PROVIDER env)
  common/
    chunkForDiscord.ts  # Chunk text for Discord's 2000-char limit
    sessionStore.ts     # Persist Discord key → provider session ID (per provider)
    providerStore.ts    # Persist Discord key → active provider override
    mcpConfig.ts        # VS Code-style MCP config loader/status
  handlers/
    mention.ts          # @mentions, free-channel messages, bot-owned thread messages
    slash/              # One handler per slash command
  utils/                # Attachment download + Discord message-link resolution
scripts/
  register-commands.ts  # One-time slash command registration
patch-deps.cjs          # Copilot SDK ESM patch (runs on install)
.github/workflows/      # CI, release, and dependabot automation
ai-assistant.service    # systemd unit template (%%PLACEHOLDER%% vars, patched by install-service)
.env.example            # Environment variable template
```

### Adding a provider

1. Implement the [`Provider`](src/providers/types.ts) interface in a new file under `src/providers/`.
2. Register it in the [`createProvider()`](src/providers/index.ts) factory.
3. Add it to the `PROVIDERS` list and the CLI wizard (`src/cli.ts`).
4. Any method you can't implement throws `UnsupportedError`, and the matching slash command automatically reports "provider does not support X".
