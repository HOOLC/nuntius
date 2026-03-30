# README.agent.md

This document is for an agent, operator, or automation worker that needs to understand, run, or modify nuntius quickly and correctly.

The short version:

- read the design doc first
- configure `nuntius.toml`
- build before running
- edit `src/`, never `dist/`
- test changes before finishing

## Read Order

Use this order when loading context:

1. [docs/im-codex-bridge-design.md](docs/im-codex-bridge-design.md)
2. [AGENTS.md](AGENTS.md)
3. [config/nuntius.example.toml](config/nuntius.example.toml)
4. [config/repository-registry.example.toml](config/repository-registry.example.toml)
5. Platform setup docs if the task is integration-specific:
   - [docs/slack-setup.md](docs/slack-setup.md)
   - [docs/discord-setup.md](docs/discord-setup.md)
   - [docs/feishu-setup.md](docs/feishu-setup.md)

## Mental Model

One thread can hold two different Codex surfaces:

- handler session: conversational front-end before binding
- worker session: repo-scoped session after binding

Important invariants:

- unbound threads route through the handler
- bound threads route straight to the worker
- rebinding clears the old worker session
- reset scope matters
- scheduled tasks are background jobs created from conversational requests
- worker wake requests are delayed continuations of the same worker session

If you are about to change routing, read `src/service.ts` and `src/service-state.ts` before writing code.

## Setup for Local Work

### Prerequisites

- Node.js 22 or newer
- npm
- Codex CLI installed locally
- platform credentials only if you need to run real Slack, Discord, or Feishu integrations

### Install

```bash
npm install
```

### Create config

```bash
cp config/nuntius.example.toml nuntius.toml
cp config/repository-registry.example.toml config/repository-registry.toml
```

Then set:

- repository paths that exist on the current machine
- platform credentials
- allowed users / admin users
- any registry path override

If you want to keep config elsewhere:

```bash
export NUNTIUS_CONFIG_PATH=/absolute/path/to/nuntius.toml
```

### Build

```bash
npm run build
```

### Run

Local simulator:

```bash
npm run im:local
```

Slack:

```bash
npm run slack:start
```

Discord:

```bash
npm run discord:start
```

Feishu:

```bash
npm run feishu:start
```

All configured integrations:

```bash
npm run start
```

### Test

```bash
npm run typecheck
npm test
```

## Runtime Defaults You Must Not Miss

- `bridge.yolo_mode` defaults to `true`.
- In yolo mode, all handler and worker turns are forced to `danger-full-access` and `approvalPolicy: never`.
- Repository targets default to `allow_codex_network_access = true`.
- Worker turns with network access request `codex --search`.
- `bridge.progress_updates` defaults to `minimal`.

If a user asks why sandbox or approval settings are not taking effect, check whether `bridge.yolo_mode` is still enabled.

## Repository Layout

These files carry most of the system behavior:

- `src/service.ts`
  - main orchestration
  - queueing
  - handler/worker routing
  - reset and interrupt logic
  - scheduled tasks
  - wake-up turns
- `src/service-state.ts`
  - conversation binding state
  - handler config reconciliation
  - worker prompt helpers
- `src/codex-runner.ts`
  - Codex app-server transport
  - session lifecycle
  - interrupt handling
  - `--search` behavior
  - sandbox and approval overrides
- `src/interaction-router.ts`
  - `/codex` command parsing
  - status/help output
- `src/slack-bot.ts`
  - Slack HTTP entrypoint
  - events, slash commands, replies, reactions
- `src/discord-bot-worker.ts`
  - Discord gateway worker
  - slash commands, thread behavior, admin flows
- `src/feishu-bot.ts`
  - Feishu long connection client
  - group-thread and DM behavior
- `src/worker-supervisor.ts`
  - hot reload worker replacement
- `src/process-guard.ts`
  - restart guard
- `src/persistent-launch.ts`
  - optional `systemd-run` handoff

Other important areas:

- `config/`: sample runtime config and repository registry files
- `docs/`: operator-facing design and setup docs
- `test/`: Node test suite
- `dist/`: generated output from `npm run build`

## Change Map

Use this when deciding where to edit and what else to update.

### Routing or Session Changes

Edit:

- `src/service.ts`
- `src/service-state.ts`
- sometimes `src/interaction-router.ts`

Usually update:

- `docs/im-codex-bridge-design.md`
- `test/service-routing.test.mjs`

### Codex Launch, Sandbox, Network, or Approval Changes

Edit:

- `src/codex-runner.ts`
- maybe `src/config.ts`

Usually update:

- config examples in `config/`
- `test/codex-network-access.test.mjs`
- any setup docs affected by the change

### Slack Changes

Edit:

- `src/slack-bot.ts`
- `src/adapters/slack.ts`

Usually update:

- `docs/slack-setup.md`
- `test/slack-bot.test.mjs`

### Discord Changes

Edit:

- `src/discord-bot-worker.ts`
- `src/adapters/discord.ts`
- `src/register-discord-commands.ts` if slash schema changes

Usually update:

- `docs/discord-setup.md`
- relevant Discord tests
- run `npm run discord:register` when deploying changed slash commands

### Feishu Changes

Edit:

- `src/feishu-bot.ts`
- `src/adapters/feishu.ts`

Usually update:

- `docs/feishu-setup.md`
- `test/feishu-bot.test.mjs`
- `test/feishu-adapter.test.mjs`

## Scheduled Tasks and Wake-Ups

There are two background mechanisms:

### Scheduled Tasks

- created from conversational handler requests
- stored under `.nuntius/scheduled-tasks/<task-id>/` in the repository
- executed later by fresh worker turns

Relevant files:

- `src/scheduled-task-store.ts`
- `src/scheduled-task-scheduler.ts`
- `src/scheduled-task-documents.ts`
- `src/service.ts`

### Worker Wake Requests

- created by worker action tags like `[[ACTION:WAKE_AFTER(5m)]]`
- tied to the current worker session
- resumed later as background worker turns
- not automatically posted back to chat

Relevant files:

- `src/worker-protocol.ts`
- `src/worker-wake-scheduler.ts`
- `src/service.ts`

## Platform Behavior Summary

### Slack

- root channel messages only matter when the bot is mentioned
- DMs are persistent conversations directly
- thread replies continue existing state
- slash commands are supported
- needs public HTTPS endpoints

### Discord

- slash commands are primary for ask/bind/admin
- guild mentions can create threads automatically
- DMs and thread replies continue persistent state
- command schema changes need `npm run discord:register`

### Feishu

- group root messages only trigger on mention or `/codex`
- persistent work is moved into a Feishu thread
- later thread replies continue the same state
- no public callback URL is required because it uses long connection mode

## Agent Rules While Editing

- Edit source under `src/`.
- Never hand-edit `dist/`.
- Keep English and Chinese user-facing strings aligned if you touch localized output.
- Prefer updating tests in the same change when behavior shifts.
- If a change touches config keys, commands, or routing rules, update the matching docs and config examples.

## Typical Agent Workflow

1. Read the design doc and the specific integration/setup doc.
2. Inspect the relevant `src/` modules.
3. Make edits in `src/`.
4. Update tests and docs affected by the behavior change.
5. Run:

```bash
npm run typecheck
npm test
```

6. Report exactly what changed and what was verified.

## Operational Notes

- `restart` exits the process. A supervisor still has to bring it back.
- `hotreload` is available only where the bundled supervisor is in use.
- The bridge persists session state in `session_store_path`.
- The repository registry can be reloaded in-process through admin commands.
- A repo target can restrict access with `allow_users` and `allow_channels`.

## If You Need a Short Human Overview

Use [README.md](README.md).
