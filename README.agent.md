# README.agent.md

This file is the cookbook an agent should follow to install, configure, bootstrap, verify, and hand off nuntius.

If you are the agent doing the setup, work through the steps in order. Do not improvise the routing model. Read the design doc first.

## Goal

Bring up nuntius as a working Codex bridge for one or more of:

- Slack
- Discord
- Feishu

The service should end in a state where:

- dependencies are installed
- `nuntius.toml` exists and points at valid repository targets
- required platform credentials are present
- the project builds cleanly
- the requested integration starts successfully
- any platform-specific post-step, such as Discord command registration, is completed

## What You Must Read First

Read these before editing config or starting the service:

1. [docs/im-codex-bridge-design.md](docs/im-codex-bridge-design.md)
2. [AGENTS.md](AGENTS.md)
3. [config/nuntius.example.toml](config/nuntius.example.toml)
4. [config/repository-registry.example.toml](config/repository-registry.example.toml)
5. Integration-specific docs as needed:
   - [docs/slack-setup.md](docs/slack-setup.md)
   - [docs/discord-setup.md](docs/discord-setup.md)
   - [docs/feishu-setup.md](docs/feishu-setup.md)

## Inputs You Need From The Human

Do not guess these. Ask for them explicitly if missing.

### Always Required

- which integration or integrations to enable
- absolute local paths for each repository target
- which repository should be the default
- whether the operator accepts the default yolo mode

### Slack

- bot token
- signing secret
- allowed Slack user IDs
- admin Slack user IDs
- public HTTPS base URL for slash commands and events

### Discord

- bot token
- application ID
- optional guild ID for guild-scoped command registration
- allowed Discord user IDs
- admin Discord user IDs

### Feishu

- app ID
- app secret
- allowed open IDs
- admin open IDs

## Important Runtime Defaults

Do not miss these:

- `bridge.yolo_mode` defaults to `true`.
- In yolo mode, all handler and worker turns are forced to `danger-full-access` with `approvalPolicy: never`.
- Repository targets default to `allow_codex_network_access = true`.
- Worker turns request web access with `codex --search` unless disabled per repository.
- `bridge.progress_updates` defaults to `minimal`.

If the human expects repository-level sandbox or approval settings to matter, set `bridge.yolo_mode = false`.

## Bootstrap Procedure

### 1. Verify prerequisites

Run:

```bash
node -v
npm -v
codex --version
```

If `codex` is not on `PATH`, either stop and ask for the correct binary path or set `bridge.codex_binary` later.

### 2. Install dependencies

From the repo root:

```bash
npm install
```

### 3. Create config files

If they do not already exist:

```bash
cp config/nuntius.example.toml nuntius.toml
cp config/repository-registry.example.toml config/repository-registry.toml
```

If the operator wants config elsewhere, set:

```bash
export NUNTIUS_CONFIG_PATH=/absolute/path/to/nuntius.toml
```

### 4. Fill `nuntius.toml`

At minimum, confirm or edit:

- `[bridge].default_repository_id`
- `[bridge].handler_workspace_path`
- `[bridge].session_store_path`
- `[bridge].repository_registry_path`
- `bridge.yolo_mode`
- the requested platform sections

Use [config/nuntius.example.toml](config/nuntius.example.toml) as the template of truth.

### 5. Fill the repository registry

Add one `[[repository_targets]]` entry per repository you want nuntius to expose.

Every target needs:

- `id`
- `path`
- `sandbox_mode`

Optional per-target policy:

- `approval_policy`
- `allow_users`
- `allow_channels`
- `allow_codex_network_access`
- `codex_network_access_workspace_path`
- `codex_config_overrides`

Use [config/repository-registry.example.toml](config/repository-registry.example.toml) as the template of truth.

### 6. Build

```bash
npm run build
```

### 7. Run validation

At minimum:

```bash
npm run typecheck
npm test
```

If the operator wants only a smoke test before real credentials are used, you can also run:

```bash
npm run im:local
```

### 8. Do platform-specific setup

#### Slack

- confirm slash command endpoints match `command_path`
- confirm event subscription URL matches `events_path`
- confirm the app has the required scopes from [docs/slack-setup.md](docs/slack-setup.md)

Start it with:

```bash
npm run slack:start
```

#### Discord

Build first, then register commands:

```bash
npm run build
npm run discord:register
```

Start it with:

```bash
npm run discord:start
```

#### Feishu

Confirm the app is configured for long connection event delivery and has the required permissions from [docs/feishu-setup.md](docs/feishu-setup.md).

Start it with:

```bash
npm run feishu:start
```

#### All configured integrations

```bash
npm run start
```

### 9. Verify live behavior

Use the relevant platform flow:

- Slack DM or slash command
- Discord slash command, DM, or mention
- Feishu DM or mention in a group

Minimum expected checks:

- `/codex help` or equivalent works
- `/codex repos` lists the configured repositories
- binding to a repository works
- a follow-up message in the same thread routes to the worker session

## Hand-Off Checklist

Before you say setup is complete, confirm:

- config files are in place
- repository paths are correct on disk
- the requested integration process starts without immediate failure
- tests or at least build/typecheck ran successfully
- any required Discord command registration was completed
- the operator knows how to restart the service under their supervisor

## Suggested Prompts An Agent Can Follow

### Full bootstrap

Use this if the human wants you to do the setup end to end:

```text
Read README.agent.md, docs/im-codex-bridge-design.md, and the platform setup docs you need. Install dependencies, create nuntius.toml plus config/repository-registry.toml from the examples, ask me for any missing credentials or repository paths, then build, test, and start the requested integration.
```

### Config-only bootstrap

Use this if the human is not ready to start the service yet:

```text
Read README.agent.md and prepare nuntius.toml plus config/repository-registry.toml for this machine. Do not launch anything until you have asked me for all missing credentials, allowed-user lists, and repository paths.
```

### Validate an existing install

```text
Read README.agent.md and verify this nuntius deployment. Check config paths, repository registry entries, build, typecheck, tests, and the platform-specific runtime prerequisites. Tell me exactly what is missing or misconfigured.
```

## Repo Map For Follow-Up Work

After setup, these files matter most for maintenance:

- `src/service.ts`: orchestration, routing, resets, interrupts, wake-ups, scheduled tasks
- `src/service-state.ts`: binding state and prompt helpers
- `src/codex-runner.ts`: Codex launch/session behavior
- `src/slack-bot.ts`: Slack entrypoint
- `src/discord-bot-worker.ts`: Discord entrypoint
- `src/feishu-bot.ts`: Feishu entrypoint
- `src/worker-supervisor.ts`, `src/process-guard.ts`, `src/persistent-launch.ts`: reload/restart behavior
- `test/`: regression coverage

## Editing Rules If Setup Turns Into Development

- edit `src/`, not `dist/`
- keep English and Chinese user-facing strings aligned
- update tests when behavior changes
- update docs and config examples when commands, routing, or config keys change
- run `npm run typecheck` and `npm test` before finishing a code change

## If You Need The Human Overview

Use [README.md](README.md).
