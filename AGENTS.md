# AGENTS.md

## Purpose

nuntius is a Node.js and TypeScript bridge that lets Slack, Discord, and Feishu users talk to Codex. Unbound conversations go through a handler session; once a repository is bound, later plain-text turns go straight to that repo-scoped worker session.

Start with [docs/im-codex-bridge-design.md](/home/nomofu/nuntius/docs/im-codex-bridge-design.md) if you need the routing model before changing code.

## Repo Map

- `src/service.ts`: main orchestration for handler turns, worker turns, binding changes, resets, interrupts, and progress publishing
- `src/service-state.ts`: conversation binding state, handler config reconciliation, and worker prompt helpers
- `src/codex-runner.ts`: Codex app-server transport, session lifecycle, sandbox/approval overrides, `--search`, and yolo-launch behavior
- `src/interaction-router.ts`: `/codex` command parsing and status/help output
- `src/index.ts`: combined launcher that starts configured integrations
- `src/discord-bot*.ts`, `src/slack-bot.ts`, `src/feishu-bot.ts`: platform adapters and admin flows
- `src/worker-supervisor.ts`, `src/process-guard.ts`, `src/persistent-launch.ts`: hot reload, restart, and persistent-launch support
- `src/service-manager.ts`, `src/nuntius-service-cli.ts`: launchd/systemd user service management and CLI
- `config/*.toml`: sample bridge and repository registry config
- `docs/*.md`: operator-facing setup and design docs
- `test/*.test.mjs`: Node test suite
- `dist/`: generated build output from `npm run build`; do not edit it by hand

## Commands

- `npm run build`: compile TypeScript to `dist/`
- `npm run typecheck`: run TypeScript without emitting build output
- `npm test`: build and run the full Node test suite
- `npm run im:local`: local terminal simulator for the bridge
- `npm run start`: launch every configured IM integration
- `npm run discord:start`
- `npm run discord:register`
- `npm run feishu:start`
- `npm run slack:start`
- `npm run service:install`: install the user-level service definition
- `npm run service:start`
- `npm run service:stop`
- `npm run service:restart`
- `npm run service:status`
- `npm run service:logs`

## Config Model

- Main runtime config lives in `nuntius.toml`; `bridge.repository_registry_path` can point at a reloadable TOML or JSON repository registry.
- `bridge.yolo_mode` defaults to `true` when unset. In that mode, all handler and worker turns run with `danger-full-access` and `approvalPolicy: never`.
- Set `bridge.yolo_mode = false` if you want `bridge.handler_sandbox_mode`, repository `sandbox_mode`, and repository `approval_policy` to matter again.
- Repository targets default to `allow_codex_network_access = true`. When enabled, worker turns request web access with `codex --search` and use a derived artifacts workspace under `/tmp/nuntius-codex-network/<repo-id>`.
- Access control is per repository target via `allow_users` and `allow_channels`.

## Change Expectations

- Edit source under `src/`; rebuild instead of hand-editing `dist/`.
- When changing commands, config keys, routing rules, or admin flows, update the matching docs in `docs/` and the config examples in `config/`.
- Keep English and Chinese user-facing text aligned when touching localized output.
- Routing and session-policy changes usually need test coverage in `test/service-routing.test.mjs` and sometimes `test/codex-network-access.test.mjs`.
- Discord slash-command changes also require `npm run discord:register` when deployed.
