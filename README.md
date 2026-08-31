# AI Assistant

A single personal Discord bot that runs on **GitHub Copilot**, **OpenAI Codex**, or **OpenCode** — pick your AI provider with one config value. Chat with your AI from Discord channels, DMs, and bot-owned threads, with full tool access, persistent per-conversation sessions, slash commands, and thread-based isolation.

This repo replaces the two separate implementations, [ai-assistant-copilot-sdk](https://github.com/Rubiss-Projects/ai-assistant-copilot-sdk) and [ai-assistant-codex-sdk](https://github.com/Rubiss-Projects/ai-assistant-codex-sdk), with one codebase behind a provider abstraction.

## Quick Install

```bash
# Install directly from GitHub (no cloning required)
npm install -g --install-links github:Rubiss-Projects/ai-assistant

# Run the setup wizard — creates ~/.ai-assistant/.env
ai-assistant setup

# Start the bot
ai-assistant start

# Optional: install as a systemd service (auto-start on boot)
ai-assistant install-service
```

### Sandboxed Docker deployment

Each release also publishes `ghcr.io/rubiss-projects/ai-assistant:<version>` for
running the bot without giving it access to the host filesystem. Copy
`.env.example` to `.env`, configure Discord and a provider, then run:

```bash
docker compose pull
docker compose up -d
docker compose logs -f assistant
```

On each `compose up`, the container idempotently registers the current slash
command set before starting the bot. Set `REGISTER_COMMANDS_ON_START=false` in
`.env` to disable that behavior.

Compose passes every entry in `.env` into the bot, so no corresponding edit to
`compose.yaml` is needed. Provider and model defaults can be selected directly:

```env
PROVIDER=codex             # copilot | codex | opencode
COPILOT_MODEL=claude-haiku-4.5
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=low # minimal | low | medium | high | xhigh | max | ultra
OPENCODE_MODEL=openrouter/anthropic/claude-sonnet-4.5
# Optional instructions for the bot's personality and behavior
AI_ASSISTANT_SYSTEM_PROMPT="You are our friendly community assistant."
```

The full configuration template is `.env.example`; copy it to `.env` and
uncomment or fill only the settings you need. Provider API keys, timeout
settings, Discord access lists, MCP inputs, custom endpoints, and container
startup behavior all use the same file.

The included Compose configuration runs as an unprivileged user, drops all
Linux capabilities, prevents privilege escalation, makes the image filesystem
read-only, and mounts only a Docker-managed volume at `/data`. Agent-created
files, session state, provider credentials, and downloaded attachments remain
inside that volume. Outbound networking stays enabled so Discord, model APIs,
web search, package registries, and network-based tools continue to work.

Do not add host bind mounts, the Docker socket, `--privileged`, or host network
mode when the bot is exposed to other people. Any of those can weaken or defeat
the filesystem boundary. The Docker daemon and kernel are still part of the
trusted computing base; keep Docker and the host patched.

The image includes all three backends and their CLIs. API-key/token auth is the
best fit for an unattended container:

```env
# Copilot (account must have Copilot access)
COPILOT_GITHUB_TOKEN=github_pat_...

# Codex
OPENAI_API_KEY=sk-...

# OpenCode (use the environment variable expected by the selected provider)
ANTHROPIC_API_KEY=...
```

CLI logins are also available and persist in the `assistant-data` volume:

```bash
docker compose run --rm assistant copilot login
docker compose run --rm assistant codex login
docker compose run --rm assistant opencode auth login
```

The bundled executables and writable CLI configuration live inside the
container boundary; no host CLI login is inherited unless you deliberately
mount host credential files.

Update to latest:
```bash
npm install -g --install-links github:Rubiss-Projects/ai-assistant
# or: ai-assistant update  (prints the command)
```

> **Prerequisites**: Node.js 18+ and one configured AI backend (see below).

## Choosing a provider

Set `PROVIDER` in `~/.ai-assistant/.env` (or use the `ai-assistant setup` wizard):

| `PROVIDER` | Backend | Auth |
|------------|---------|------|
| `copilot` | GitHub Copilot SDK | `gh` CLI authenticated with a GitHub account that has Copilot access |
| `codex` | OpenAI Codex SDK | `OPENAI_API_KEY`, or an existing Codex CLI login |
| `opencode` | OpenCode CLI | `opencode auth login` |

```env
PROVIDER=codex
```

All three expose the same Discord surface. Features a provider doesn't support
(e.g. `/plan` on Codex/OpenCode) reply with a friendly
"`<provider>` does not support `<feature>`" message instead of failing.

### Custom system prompt

The operator can give the bot persistent custom instructions without changing
how Discord users talk to it:

```env
AI_ASSISTANT_SYSTEM_PROMPT="Use a playful tone, but be concise."
```

For a long or multiline prompt, point to a UTF-8 file instead. The file setting
takes precedence when both are present:

```env
AI_ASSISTANT_SYSTEM_PROMPT_FILE=/home/bot/.ai-assistant/system-prompt.txt
```

`ai-assistant setup` offers both settings. Native/daemon installs load them
from `~/.ai-assistant/.env`; Docker Compose passes the same setting from the
project `.env`. A prompt file used in the provided container must live under
`/data`, such as `/data/system-prompt.txt`, because that is its persistent
Docker volume. Restart the bot after changing either setting. Existing Copilot
and Codex sessions may need `/reset` to guarantee that newly changed session
instructions take effect.

## Switching providers at runtime

Every session (a `/chat` thread, or a user's DM) has an **active provider**.
It defaults to `PROVIDER` but you can change it on the fly with `/provider` —
no restart required:

```
/provider list          # show available providers + the active one
/provider set codex     # switch THIS thread/session to Codex
/provider current       # show the active provider for this session
```

- The choice is scoped: set it inside a thread and it applies to that thread;
  set it in a channel/DM and it applies to that user's session.
- Choices are persisted (per thread/user in `~/.config/ai-assistant/providers.json`),
  so they survive a bot restart.
- Each provider keeps its **own** session history per Discord key (namespaced
  on disk). Switching to another provider starts that provider's thread fresh;
  switching back resumes that provider's earlier thread for that key. There is
  no automatic conversation handoff between different providers.

## Features

- **Thread-based chat** — `/chat` spawns a dedicated Discord thread per conversation, each with its own isolated session context
- **Free-form chat** in a designated channel — no `@mention` required
- **Conversation-aware mentions** — mentions include recent channel conversation; replies center context around the referenced message
- **Persistent session** per user/thread — history maintained across messages and bot restarts
- **Conversational long-term memory** — say “remember this” and recall relevant server memories later without a command
- **Discord history search** — ask naturally to search the current channel or accessible server channels, with source links
- **Full tool access** — the AI can read files, run shell commands, search the web, etc.
- **User-scope skills** — Copilot automatically loads skills from `~/.agents/skills` at session start
- **Model switching** — change the model per-user at runtime (`/model set`)
- **Reasoning effort control** — per-session on Copilot and Codex (`/reasoning`)
- **Slash commands** for quick actions and session management
- **User allowlist** — restrict access to specific Discord user IDs
- **Image attachments** — forwarded to the AI as context (Copilot/Codex/OpenCode)
- **Auto-restart** via systemd (WSL + Linux)

## Slash Commands

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

### How `/chat` works

- **In a channel** — creates a new public thread named `{Provider}: {your message}`. The session is isolated to that thread. Just type in the thread — no `@mention` needed.
- **Already in a thread** — continues the conversation in that thread's session.
- **In a DM** — responds inline; the whole DM is one persistent session.

## Setup

### Developer Setup (clone the repo)

#### 1. Prerequisites

- Node.js 18+
- A [Discord application](https://discord.com/developers/applications) with a bot user
- One AI backend:
  - **Copilot**: `gh auth login` with a Copilot-enabled GitHub account
  - **Codex**: `OPENAI_API_KEY` or Codex CLI login (`codex login`)
  - **OpenCode**: `opencode auth login` (configure any provider from models.dev)

#### 2. Clone and install

```bash
git clone git@github.com:Rubiss-Projects/ai-assistant.git
cd ai-assistant
npm install
```

#### 3. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
PROVIDER=copilot            # copilot | codex | opencode

DISCORD_TOKEN=              # Bot token from Discord Developer Portal → Bot
DISCORD_APP_ID=             # Application ID from Discord Developer Portal → General Information
DISCORD_GUILD_ID=           # Your Discord server ID (for slash command registration)
DISCORD_FREE_CHANNELS=      # Optional: comma-separated channel IDs where bot replies without @mention
DISCORD_ALLOWED_USERS=      # Optional: comma-separated user IDs allowed to use the bot
DISCORD_ADMIN_USERS=        # Optional: user IDs allowed to use administrative actions
DISCORD_ATTACHMENT_MODE=native # native | text (recommended for shared bots)

# Provider-specific (see .env.example for the full list)
# OPENAI_API_KEY=sk-...                  # for codex
# CODEX_MODEL=gpt-5.6-sol                # for codex
# COPILOT_MODEL=claude-haiku-4.5         # for copilot
# OPENCODE_MODEL=openrouter/...          # for opencode
```

**Getting IDs**: Enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then right-click any server/channel/user to copy its ID.

### Discord access and permissions

These settings work identically in Docker and native installs. With both user
lists empty, everybody in a server containing the bot can interact with it.

- `DISCORD_ALLOWED_USERS` controls normal messages, mentions, and public slash
  actions. Set it to comma-separated Discord user IDs to make the bot private.
- `DISCORD_ADMIN_USERS` controls administrative slash actions. Admins can also
  use every public action. When this setting is empty, admin access falls back
  to `DISCORD_ALLOWED_USERS`; when both are empty, everybody has admin access.
- `DISCORD_FREE_CHANNELS` lists channels where an allowed user can talk to the
  bot without mentioning it. In every other visible channel, the bot listens
  but responds only when its account is explicitly `@mentioned`. Bot-owned chat
  threads respond without a mention.
- Mentions and free-channel responses include nearby channel conversation for
  context. A reply that mentions the bot also includes the replied-to message
  and nearby messages. Images and supported text/code attachments on the direct,
  replied-to, nearby, or Discord-linked messages are included too. Sessions
  remain isolated by channel/thread and persist across container restarts in
  the `assistant-data` volume.
- Natural requests such as “remember that Dave owes Sam a wheel of cheese” are
  stored durably for the server. Relevant records are recalled automatically in
  later conversations. “Forget the cheese agreement” removes matching records.
  Each memory retains its source channel, and is returned only while the
  requester can still read that channel.
- Requests such as “search this channel for the beach plans” use Discord's
  indexed guild search; “search across the server” broadens the permitted
  scope. The AI generates several synonym-aware queries, gathers up to 200
  unique candidates, semantically reranks them, and supplies the best 50 with
  message permalinks. Tune these pools with `DISCORD_SEARCH_CANDIDATE_LIMIT`
  and `DISCORD_SEARCH_CONTEXT_LIMIT`.
  Discord's search endpoint requires **Read Message History** and the
  **Message Content Intent** to be enabled for the application in the Discord
  Developer Portal.
- `DISCORD_ATTACHMENT_MODE=native` passes accepted attachments to the provider
  as temporary files. Set `DISCORD_ATTACHMENT_MODE=text` for a shared bot: all
  non-image attachments are delimited as untrusted text in the prompt and no
  path to an attached code/config file is exposed to the agent. The temporary
  upload is deleted before the provider runs, preventing the agent from finding
  or executing that file. Images remain native vision inputs in both modes.

Public slash actions are `/ask`, `/chat`, `/reset`, `/history`, `/compact`, all
`/plan` actions, and the read-only `list`/`current`/`get` actions under `/model`,
`/reasoning`, `/provider`, `/agent`, and `/mode`. Supplying the optional
`workspace` argument to `/ask` or `/chat` makes that invocation administrative.

Administrative actions are `/model set`, `/reasoning set`, `/provider set`,
`/agent select`, `/agent deselect`, `/mode set`, and every action under
`/workspace` and `/mcp`, plus `/servers`, `/leave`, `/status`, and `/fleet`.
Unknown commands and subcommands default to admin-only so newly added operations
are not accidentally exposed.

#### 4. Invite the bot to your server

In the [Discord Developer Portal](https://discord.com/developers/applications), go to:
**OAuth2 → URL Generator** → select scopes: `bot` + `applications.commands`

Under Bot Permissions, select at minimum:
**Send Messages**, **Send Messages in Threads**, **Create Public Threads**, **Read Message History**, **Use Slash Commands**.

Copy the generated URL and open it in a browser to invite the bot to your server.

#### 5. Register slash commands

```bash
npm run register
```

Run this once (and again whenever you add or change slash commands).

#### 6. Start the bot

```bash
npm start
```

## Migrating from the Copilot/Codex versions

If you currently run a bot from the separate, provider-specific repos — [ai-assistant-copilot-sdk](https://github.com/Rubiss-Projects/ai-assistant-copilot-sdk) or [ai-assistant-codex-sdk](https://github.com/Rubiss-Projects/ai-assistant-codex-sdk) — this repo is a drop-in replacement. Migrating lets you use **`/provider`** to switch between Copilot, Codex, and OpenCode at runtime instead of running a separate bot per provider.

Both older packages install the same `ai-assistant` CLI, so uninstall whichever you have before installing this one:

```bash
npm uninstall -g ai-assistant
```

Then install this package (your config in `~/.ai-assistant/.env` is preserved):

```bash
npm install -g --install-links github:Rubiss-Projects/ai-assistant
```

### What carries over

The Discord configuration is identical across all versions, so your existing
settings transfer as-is:

- `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`
- `DISCORD_FREE_CHANNELS`, `DISCORD_ALLOWED_USERS`, `DISCORD_ADMIN_USERS`
- `MCP_CONFIG_PATH`, `MCP_INPUT_*`

The AI configuration changes as follows:

| Copilot version | Codex version | Unified version |
| --- | --- | --- |
| Copilot authentication via `gh` CLI | `OPENAI_API_KEY` or Codex CLI login | Unchanged — each provider keeps its own auth |
| `COPILOT_TIMEOUT_MS` | `CODEX_TIMEOUT_MS` | Still respected per provider; plus `OPENCODE_TIMEOUT_MS` for OpenCode |
| Copilot model IDs (`COPILOT_MODEL`) | Codex/OpenAI model IDs (`CODEX_MODEL`) | `COPILOT_MODEL` / `CODEX_MODEL` / `OPENCODE_MODEL` |
| — | — | New `PROVIDER=copilot\|codex\|opencode` sets the default backend |

### Replacement flow (global install)

```bash
# If running as a service, stop it first
sudo systemctl stop ai-assistant

# Uninstall whatever version you have, then install the unified one
npm uninstall -g ai-assistant
npm install -g --install-links github:Rubiss-Projects/ai-assistant

# Update ~/.ai-assistant/.env interactively (Discord values are preserved,
# and you'll be prompted for PROVIDER + your provider's credentials)
ai-assistant setup

# Replace guild slash commands with the unified command set
ai-assistant register

# Refresh the systemd unit if you use it, then start
ai-assistant install-service
sudo systemctl start ai-assistant
```

If you run the bot manually (no service), just `ai-assistant start` after
`ai-assistant register`. Everything else — thread-based `/chat` sessions, skills,
`/ask`, permission allowlists — works the same as before.


## Project Structure

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

## Adding a new provider

1. Implement the [`Provider`](src/providers/types.ts) interface in a new file under `src/providers/`.
2. Register it in the [`createProvider()`](src/providers/index.ts) factory.
3. Add it to the `PROVIDERS` list and the CLI wizard (`src/cli.ts`).
4. Any method you can't implement throws `UnsupportedError`, and the matching slash command automatically reports "provider does not support X".

## Security Notes

- The bot token and all credentials live only in `.env`, which is git-ignored and never committed.
- Use `DISCORD_ALLOWED_USERS` to restrict the bot to your own Discord user ID — especially important since the bot has full tool access to your machine.
- Use `DISCORD_ADMIN_USERS` to reserve configuration, workspace, MCP, and server-management actions for trusted users while allowing everyone selected by `DISCORD_ALLOWED_USERS` to chat and use public slash actions. See **Discord access and permissions** above for the complete command split and fallback rules.
- Copilot uses `approveAll` permissions — it will execute any tool Copilot requests without prompting. Only expose it to users you trust completely.
- For a shared Discord bot, prefer the Docker deployment and set `DISCORD_ALLOWED_USERS` unless intentionally allowing the whole server. The container protects host files, but users can still consume credentials, model quota, network access, and the container's persistent data.
- Thread sessions are isolated by thread ID, so different `/chat` conversations don't share context.

## Uninstall

```bash
# Stop and remove the systemd service (if installed)
sudo systemctl stop ai-assistant
sudo systemctl disable ai-assistant
sudo rm /etc/systemd/system/ai-assistant.service
sudo systemctl daemon-reload

# Remove the npm package
npm uninstall -g ai-assistant

# Remove config and credentials (optional — destructive)
rm -rf ~/.ai-assistant
```
