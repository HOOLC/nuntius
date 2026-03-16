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

## Feishu App Setup

Enable bot capability for the app, then publish a version after changing scopes or event settings.

Recommended permissions:

- `im:message.p2p_msg:readonly`
- `im:message.group_at_msg:readonly`
- `im:message:send`
- `im:message:update`

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
- There is no Feishu callback URL to keep in sync because events are received over the SDK's long connection client.
