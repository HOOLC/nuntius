# Feishu Setup

## Required Environment

Create a `nuntius.toml` file in the project root or point `NUNTIUS_CONFIG_PATH` at one.

Example: [config/nuntius.example.toml](/home/nomofu/nuntius/config/nuntius.example.toml)

Minimal Feishu section:

```toml
[feishu]
app_id = "cli_xxxxxxxxxxxxxxxx"
app_secret = "your-feishu-app-secret"
allowed_open_ids = ["ou_xxxxxxxxxxxxxxxx"]
admin_open_ids = ["ou_xxxxxxxxxxxxxxxx"]
```

Optional:

```toml
[feishu]
allow_process_restart = false
api_base_url = "https://open.feishu.cn/open-apis"
```

For a reloadable repo registry, point the bridge at a TOML file:

```toml
[bridge]
repository_registry_path = "config/repository-registry.toml"
```

Example format: [config/repository-registry.example.toml](/home/nomofu/nuntius/config/repository-registry.example.toml)

## Bridge Policy Defaults

By default the bridge runs Codex in bridge-level yolo mode:

```toml
[bridge]
yolo_mode = true
```

When `bridge.yolo_mode` is `true` or omitted, all handler and worker turns are forced to `danger-full-access` with `approvalPolicy: never`.

Set `bridge.yolo_mode = false` if you want `bridge.handler_sandbox_mode` plus each repository target's `sandbox_mode` and `approval_policy` settings to take effect.

Repository targets also default to `allow_codex_network_access = true`, so worker turns request web access with `codex --search` unless you disable that per repository.

`bridge.progress_updates` defaults to `minimal`, which keeps intermediate replies sparse and prefers working placeholders/heartbeats when available. Set it to `verbose` to surface more per-step progress messages, or `off` to wait for the final reply.

## Feishu App Setup

Enable bot capability for the app, then publish a version after changing scopes or event settings.

Recommended permissions:

- `im:message.p2p_msg:readonly`
- `im:message.group_at_msg:readonly`
- `im:message:send`
- `im:message:update`
- `im:message.reactions:write_only`
- `im:resource`

`im:resource` is needed if you want the bot to download inbound file attachments from Feishu and upload modified files back into the conversation. The upload API also documents the newer `im:resource:upload` scope, but `im:resource` covers the end-to-end attachment flow used by nuntius.

Event subscription:

- Subscribe to `im.message.receive_v1`
- Configure subscription mode as "Receive events through long connection"
- No callback URL or health check endpoint is required
- Long connection mode only supports event subscriptions, which is sufficient for nuntius

## Run

```bash
npm run build
npm run feishu:start
```

The process only needs outbound network access to Feishu. You do not need a public HTTP endpoint or intranet tunneling.

Or run all configured IM integrations together:

```bash
npm run build
npm run start
```

To hand the process off to a transient user service when the host allows it:

```bash
NUNTIUS_LAUNCH_MODE=systemd-run npm run feishu:start
```

Or for the combined launcher:

```bash
NUNTIUS_LAUNCH_MODE=systemd-run npm run start
```

This requires `systemd-run --user`. If host policy blocks transient user services, nuntius exits with a clear error instead of pretending the process stayed alive.

## Supported Feishu Flows

### Message Commands

- `/codex <message>`
- `/codex bind <repo-id>`
- `/codex status`
- `/codex repos`
- `/codex tasks`
- `/codex reset [worker|binding|context|all]`
- `/codex interrupt`
- `/codex help`

### Admin Commands

- `/codexadmin status`
- `/codexadmin reloadconfig`
- `/codexadmin hotreload`
- `/codexadmin restart`
- `/codexadmin help`

### Conversational Flow

- DM the bot directly to keep one Codex conversation per p2p chat
- Mention the bot in a group message to create a dedicated Feishu thread automatically
- Reply inside that Feishu thread to continue the same handler or worker session

### Document Attachments

- In a DM or an already-bound thread, send a `doc` or `docx` file and then tell Codex what to change
- nuntius downloads the attachment to a local working path and exposes that path to Codex for the turn
- If Codex modifies an attached `.doc` or `.docx` in place, or writes a new `.doc`/`.docx` beside it in the same attachment directory, nuntius uploads that file back to Feishu as a file message
- Feishu file uploads are limited to 30 MB; larger returned documents will fail to upload and the bot will post an error in the thread instead

## Notes

- If `feishu.allowed_open_ids` is set, only those Feishu users can talk to the bot.
- If `feishu.admin_open_ids` is set, only those users can run `/codexadmin`.
- Root group messages only trigger the bot when they start with `/codex` or mention the bot.
- Persistent work in a group is moved into a Feishu thread automatically; later replies in that thread reuse the same bound worker session.
- In an unbound top-level conversation, plain text like `create a task running per hour in arbitero` lets the handler create a scheduled background task under `.nuntius/scheduled-tasks/<task-id>/` for that repository without binding the thread.
- nuntius adds status reactions to inbound Feishu messages when the bot can address the source message directly.
- File attachments received in a conversation remain available to later turns in that conversation unless you clear the binding with `/codex reset binding` or `/codex reset all`.
- `/codexadmin reloadconfig` reloads the bridge config and repository registry in-process.
- `/codexadmin hotreload` runs `npm run build`, probes the rebuilt Feishu worker, then swaps the active worker when the bot is running under the bundled supervisor started by `npm run feishu:start` or `npm run start`.
- `/codexadmin restart` only exits the process. Use systemd, Docker restart policy, or another supervisor to bring it back up.
- There is no Feishu callback URL to keep in sync because events are received over the SDK's long connection client.
