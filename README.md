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
- **Persistent session** per user/thread — history maintained across messages and bot restarts
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

# Provider-specific (see .env.example for the full list)
# OPENAI_API_KEY=sk-...                  # for codex
# CODEX_MODEL=gpt-5.6-sol                # for codex
# COPILOT_MODEL=claude-haiku-4.5         # for copilot
# OPENCODE_MODEL=openrouter/...          # for opencode
```

**Getting IDs**: Enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then right-click any server/channel/user to copy its ID.

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
- `DISCORD_FREE_CHANNELS`, `DISCORD_ALLOWED_USERS`
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
- Copilot uses `approveAll` permissions — it will execute any tool Copilot requests without prompting. Only expose it to users you trust completely.
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
