# Discord Setup

## Required Environment

Create a `nuntius.toml` file in the project root or point `NUNTIUS_CONFIG_PATH` at one.

Example: [config/nuntius.example.toml](/home/nomofu/nuntius/config/nuntius.example.toml)

Minimal Discord section:

```toml
[discord]
token = "discord-bot-token"
application_id = "123456789012345678"
allowed_user_ids = ["111111111111111111"]
admin_user_ids = ["111111111111111111", "222222222222222222"]
```

Optional:

```toml
[discord]
guild_id = "123456789012345678"
thread_name_prefix = "codex"
thread_auto_archive_minutes = 1440
allow_process_restart = true
```

For a reloadable repo registry, point the bridge at a TOML file:

```toml
[bridge]
repository_registry_path = "config/repository-registry.toml"
```

Example format: [config/repository-registry.example.toml](/home/nomofu/nuntius/config/repository-registry.example.toml)

If you do not use a separate registry file, you can also inline `[[repository_targets]]` directly in `nuntius.toml`.

Environment variables still work as overrides and fallback, but they are no longer required.

## Discord Developer Portal

Enable these bot capabilities:

- `MESSAGE CONTENT INTENT`

Required bot permissions in the target server/channel:

- View Channels
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Add Reactions
- Use Slash Commands

## Register Commands

Build first:

```bash
npm run build
```

Register commands:

```bash
npm run discord:register
```

If `discord.guild_id` in `nuntius.toml` or `NUNTIUS_DISCORD_GUILD_ID` is set, commands register to that guild only.
If not set, commands register globally.

## Run

```bash
npm run discord:start
```

Or run all configured IM integrations together:

```bash
npm run build
npm run start
```

## Supported Discord Flows

### Slash Commands

- `/codex ask prompt:<text> [repo:<repo-id>]`
- `/codex bind repo:<repo-id>`
- `/codex status`
- `/codex repos`
- `/codex reset [scope]`
- `/codex help`

### Admin Commands

- `/codexadmin status`
- `/codexadmin reloadconfig`
- `/codexadmin hotreload`
- `/codexadmin restart`

### Conversational Flow

- DM the bot directly
- Reply inside an existing Codex thread
- Mention the bot in a guild text channel or announcement channel to create a new Codex thread automatically

## Notes

- If `NUNTIUS_DISCORD_ALLOWED_USER_IDS` is set, the bot only responds to those Discord user IDs.
- If `discord.allowed_user_ids` is set in `nuntius.toml`, the bot only responds to those Discord user IDs.
- Slash commands from blocked users get an ephemeral denial.
- Messages, mentions, and thread replies from blocked users are ignored.
- Slash `ask` in a guild text channel or announcement channel creates a thread automatically.
- Slash `bind` in a guild text channel or announcement channel also creates a thread automatically.
- Normal guild-channel messages are ignored unless they mention the bot.
- Once a thread or DM is bound to a repo, later replies go straight to that worker session; use `/codex bind` or `/codex reset` to change the routing explicitly.
- nuntius adds status reactions to inbound Discord chat messages; slash-command interactions keep using deferred ephemeral acknowledgements.
- `/codexadmin` is restricted to Discord user IDs listed in `NUNTIUS_DISCORD_ADMIN_USER_IDS`.
- `/codexadmin reloadconfig` reloads the TOML config and repo registry in-process.
- `/codexadmin hotreload` runs `npm run build` in the bridge repo first, then reconnects the Discord worker using the rebuilt `dist` code.
- `/codexadmin restart` still exits the whole supervisor process. You still need systemd, Docker restart policy, or another supervisor to bring it back up.
- Run `npm run discord:register` after changing slash command definitions.

## Safe Self-Update Flow

1. Configure the integration repo itself as a normal repo target in the registry file.
2. In Discord, bind a thread to that repo and ask Codex to edit the integration code or the registry file.
3. Review the changes in the repo.
4. Use `/codexadmin reloadconfig` if the registry file changed.
5. Use `/codexadmin hotreload` if the worker code changed.
6. Use `/codexadmin restart` only when you need to reload the supervisor process itself.
7. Run `npm run discord:register` if the slash command schema changed.

This keeps editing and activation separate, which is the safety boundary.
