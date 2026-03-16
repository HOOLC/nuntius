# Feishu Setup

## Required Environment

Create a `nuntius.toml` file in the project root or point `NUNTIUS_CONFIG_PATH` at one.

Example: [config/nuntius.example.toml](/home/nomofu/nuntius/config/nuntius.example.toml)

Minimal Feishu section:

```toml
[feishu]
app_id = "cli_xxxxxxxxxxxxxxxx"
app_secret = "your-feishu-app-secret"
verification_token = "your-feishu-verification-token"
allowed_open_ids = ["ou_xxxxxxxxxxxxxxxx"]
admin_open_ids = ["ou_xxxxxxxxxxxxxxxx"]
```

Recommended when you enable encrypted callbacks:

```toml
[feishu]
encrypt_key = "your-feishu-encrypt-key"
```

Optional:

```toml
[feishu]
host = "0.0.0.0"
port = 8789
events_path = "/feishu/events"
health_path = "/healthz"
allow_process_restart = false
```

For a reloadable repo registry, point the bridge at a TOML file:

```toml
[bridge]
repository_registry_path = "config/repository-registry.toml"
```

Example format: [config/repository-registry.example.toml](/home/nomofu/nuntius/config/repository-registry.example.toml)

## Feishu App Setup

Enable bot capability for the app, then publish a version after changing scopes or callbacks.

Recommended permissions:

- `im:message.p2p_msg:readonly`
- `im:message.group_at_msg:readonly`
- `im:message:send`
- `im:message:update`

Event subscription:

- Subscribe to `im.message.receive_v1`
- Configure callback mode as "Send notifications to developer's server"
- Callback URL: `https://your-host.example.com/feishu/events`
- Health check: `https://your-host.example.com/healthz`

If you configure an `encrypt_key`, nuntius will decrypt encrypted payloads and verify signed event callbacks.

## Run

```bash
npm run build
npm run feishu:start
```

Or run all configured IM integrations together:

```bash
npm run build
npm run start
```

## Supported Feishu Flows

### Message Commands

- `/codex <message>`
- `/codex bind <repo-id>`
- `/codex status`
- `/codex repos`
- `/codex reset [worker|binding|context|all]`
- `/codex help`

### Admin Commands

- `/codexadmin status`
- `/codexadmin reloadconfig`
- `/codexadmin restart`
- `/codexadmin help`

### Conversational Flow

- DM the bot directly to keep one Codex conversation per p2p chat
- Mention the bot in a group message to create a dedicated Feishu thread automatically
- Reply inside that Feishu thread to continue the same handler or worker session

## Notes

- If `feishu.allowed_open_ids` is set, only those Feishu users can talk to the bot.
- If `feishu.admin_open_ids` is set, only those users can run `/codexadmin`.
- Root group messages only trigger the bot when they start with `/codex` or mention the bot.
- Persistent work in a group is moved into a Feishu thread automatically; later replies in that thread reuse the same bound worker session.
- `/codexadmin reloadconfig` reloads the bridge config and repository registry in-process.
- `/codexadmin restart` only exits the process. Use systemd, Docker restart policy, or another supervisor to bring it back up.
- Listener host/port and callback path changes still require updating the Feishu app configuration.
