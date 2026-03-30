# nuntius

## Quick Start

The fastest path is: paste one prompt into Codex and let the agent do the setup for you.

Copy and paste this exact line into Codex:

```text
Clone https://github.com/HOOLC/nuntius.git, read README.md and README.agent.md, install dependencies, create nuntius.toml from config/nuntius.example.toml, create config/repository-registry.toml from config/repository-registry.example.toml, ask me for any missing credentials or repository paths, then build, test, and start the integration I choose.
```

If you want Codex to stop before launching anything, use this instead:

```text
Clone https://github.com/HOOLC/nuntius.git, read README.md and README.agent.md, and prepare nuntius.toml plus config/repository-registry.toml for this machine, but do not start the service until I confirm the credentials and repository paths.
```

If you already have an install and only want Codex to verify it:

```text
Open the existing nuntius checkout, read README.md and README.agent.md, verify the installation end to end, including config, repository registry, build, tests, and platform-specific setup, then tell me exactly what is missing.
```

The agent-oriented setup cookbook lives in [README.agent.md](README.agent.md).

## Introduction

nuntius is a Node.js and TypeScript bridge that lets Slack, Discord, and Feishu users talk to Codex from chat.

It is designed for two different kinds of work in the same thread:

- conversational turns before a repository is chosen
- persistent repo-scoped coding work after a repository is bound

The bridge keeps those two modes separate on purpose. Unbound conversations go through a handler session. Once a thread is bound to a repository, later plain-text replies go straight to the worker session for that repository.

If you need the detailed routing model, start with [docs/im-codex-bridge-design.md](docs/im-codex-bridge-design.md).

## What It Does

- Bridges Codex into Slack, Discord, and Feishu
- Keeps persistent per-thread conversation state
- Separates unbound conversational routing from bound repo work
- Supports explicit repository binding and reset flows
- Runs repo-scoped worker turns with persisted Codex sessions
- Supports scheduled background tasks stored inside the target repository
- Supports delayed worker wake-ups for waiting, polling, and monitoring workflows
- Surfaces progress updates, reactions, typing indicators, or working placeholders depending on the platform

## Core Model

Each conversation can have:

- zero or one handler Codex session
- zero or one active repository binding
- zero or one worker Codex session for that repository
- zero or one pending worker wake request

### Handler Session

The handler is the conversational front-end used before a repo is bound.

It can:

- answer general questions
- ask which repository to use
- bind a repository
- reset handler or worker state
- create scheduled tasks from conversational requests

### Worker Session

The worker is the repo-scoped execution session used after binding.

It can:

- inspect and edit code
- run tests and commands
- review a bound repository
- continue the same long-lived repo conversation over multiple turns
- ask nuntius to wake the same worker session up later with `[[ACTION:WAKE_AFTER(5m)]]`

### Scheduled Tasks

The handler can also create recurring background tasks from natural language requests such as:

`create a task running per hour in nuntius`

Those tasks are stored under `.nuntius/scheduled-tasks/<task-id>/` inside the target repository and executed later by fresh background worker turns.

## Safety and Runtime Defaults

nuntius has strong defaults. Read these before deploying it.

- `bridge.yolo_mode` defaults to `true` when unset.
- In yolo mode, handler and worker turns run with `danger-full-access` and `approvalPolicy: never`.
- Set `bridge.yolo_mode = false` if you want repository-level sandbox and approval settings to take effect.
- Repository targets default to `allow_codex_network_access = true`.
- When network access is enabled, worker turns request web access with `codex --search`.
- For writable workers, nuntius also derives a temporary artifacts workspace under `/tmp/nuntius-codex-network/<repo-id>` unless you override it.

For many teams, the most important deployment decision is whether the default yolo behavior is acceptable.

## Supported Integrations

- Slack via HTTPS slash commands and event subscriptions
- Discord via bot gateway events and slash commands
- Feishu via long connection event delivery

Platform-specific setup guides live here:

- [docs/slack-setup.md](docs/slack-setup.md)
- [docs/discord-setup.md](docs/discord-setup.md)
- [docs/feishu-setup.md](docs/feishu-setup.md)

## Prerequisites

- Node.js 22 or newer
- npm
- Codex CLI installed and available as `codex`, or configured through `bridge.codex_binary`
- Chat platform credentials for whichever integration you want to run

## Manual Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a config file

Copy the sample config:

```bash
cp config/nuntius.example.toml nuntius.toml
cp config/repository-registry.example.toml config/repository-registry.toml
```

Then update:

- bridge settings
- integration credentials
- repository target paths
- allowed users and channels

### 3. Build

```bash
npm run build
```

### 4. Run one integration

```bash
npm run slack:start
```

```bash
npm run discord:start
```

```bash
npm run feishu:start
```

Or launch every configured integration together:

```bash
npm run start
```

### 5. Optional: use the local simulator

```bash
npm run build
npm run im:local
```

This is useful for local routing and service testing without a real chat platform.

## Minimal Config Shape

Example bridge config:

```toml
[bridge]
codex_binary = "codex"
default_repository_id = "nuntius"
require_explicit_repository_selection = true
progress_updates = "minimal"
handler_workspace_path = "."
handler_sandbox_mode = "danger-full-access"
session_store_path = ".nuntius/sessions.json"
repository_registry_path = "config/repository-registry.toml"
```

Example repository registry:

```toml
default_repository_id = "nuntius"

[[repository_targets]]
id = "nuntius"
path = "/srv/repos/nuntius"
sandbox_mode = "danger-full-access"
allow_channels = ["discord:123456789012345678:234567890123456789"]
```

See:

- [config/nuntius.example.toml](config/nuntius.example.toml)
- [config/repository-registry.example.toml](config/repository-registry.example.toml)

## Common User Flows

### Start Conversationally

Users can begin without choosing a repo immediately:

- "work on nuntius in this thread"
- "check why CI is failing"
- "summarize the recent changes"

The handler decides whether to reply, ask a clarifying question, bind a repo, or create a scheduled task.

### Bind a Repository

Once a repo is bound:

- the thread remembers that repository
- later plain-text replies go straight to the worker session
- the same worker session is reused until reset or rebind

### Reset or Interrupt

Users can reset worker, binding, or full context, and they can interrupt the active turn.

### Create a Scheduled Task

In an unbound conversation, a natural-language scheduling request can create a background task without binding the thread itself.

### Ask a Worker to Wake Up Later

A worker can request a delayed wake-up by including:

```text
[[ACTION:WAKE_AFTER(5m)]]
```

This is intended for waiting, polling, and monitoring work where time needs to pass before the same worker session continues.

## Development

Useful commands:

- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm run im:local`
- `npm run start`
- `npm run slack:start`
- `npm run discord:start`
- `npm run discord:register`
- `npm run feishu:start`

Important repo areas:

- `src/service.ts`: orchestration, routing, queueing, wake-ups, resets, progress publishing
- `src/service-state.ts`: persisted conversation binding state and worker prompt helpers
- `src/codex-runner.ts`: Codex app-server transport and session lifecycle
- `src/interaction-router.ts`: `/codex` command parsing and output
- `src/slack-bot.ts`, `src/feishu-bot.ts`, `src/discord-bot*.ts`: platform entrypoints
- `src/worker-supervisor.ts`, `src/process-guard.ts`, `src/persistent-launch.ts`: restart and hot-reload support
- `docs/`: operator-facing design and setup docs
- `config/`: sample config files
- `test/`: Node test suite

## Deployment Notes

- Slack needs a public HTTPS endpoint for slash commands and event subscriptions.
- Discord slash command changes require `npm run discord:register`.
- Feishu does not need a callback URL because it uses the SDK's long connection client.
- `restart` only exits the current process. Use systemd, Docker restart policy, or another supervisor to bring it back up.
- `hotreload` is available on integrations that run under the bundled supervisor flow.
- `NUNTIUS_LAUNCH_MODE=systemd-run` can hand the service off to a transient user service when the host allows it.

## Further Reading

- [docs/im-codex-bridge-design.md](docs/im-codex-bridge-design.md)
- [docs/slack-setup.md](docs/slack-setup.md)
- [docs/discord-setup.md](docs/discord-setup.md)
- [docs/feishu-setup.md](docs/feishu-setup.md)
- [AGENTS.md](AGENTS.md)
