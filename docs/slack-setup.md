# Slack Setup

## Required Environment

Create a `nuntius.toml` file in the project root or point `NUNTIUS_CONFIG_PATH` at one.

Example: [config/nuntius.example.toml](/home/nomofu/nuntius/config/nuntius.example.toml)

Minimal Slack section:

```toml
[slack]
bot_token = "xoxb-your-slack-bot-token"
signing_secret = "your-slack-signing-secret"
allowed_user_ids = ["U0123456789"]
admin_user_ids = ["U0123456789"]
```

Optional:

```toml
[slack]
host = "0.0.0.0"
port = 8788
command_path = "/slack/commands"
events_path = "/slack/events"
health_path = "/healthz"
allow_process_restart = false
```

For a reloadable repo registry, point the bridge at a TOML file:

```toml
[bridge]
repository_registry_path = "config/repository-registry.toml"
```

Example format: [config/repository-registry.example.toml](/home/nomofu/nuntius/config/repository-registry.example.toml)

## Slack App Setup

This integration uses Slack's standard HTTPS request flow. You need a publicly reachable HTTPS URL for the command and events endpoints.

Recommended bot token scopes:

- `chat:write`
- `chat:write.public`
- `commands`
- `channels:history`
- `groups:history`
- `im:history`

Recommended event subscriptions:

- `message.channels`
- `message.groups`
- `message.im`

Slash commands:

- `/codex` -> `https://your-host.example.com/slack/commands`
- `/codexadmin` -> `https://your-host.example.com/slack/commands`

Event subscriptions request URL:

- `https://your-host.example.com/slack/events`

Health check endpoint:

- `https://your-host.example.com/healthz`

## Run

```bash
npm run build
npm run slack:start
```

Or run all configured IM integrations together:

```bash
npm run build
npm run start
```

## Supported Slack Flows

### Slash Commands

- `/codex <message>` starts or continues a Codex conversation
- `/codex bind <repo-id>` creates a thread if needed and binds it
- `/codex status`
- `/codex repos`
- `/codex reset [worker|binding|all]`
- `/codex help`

### Admin Commands

- `/codexadmin status`
- `/codexadmin reloadconfig`
- `/codexadmin restart`
- `/codexadmin help`

### Conversational Flow

- DM the app directly to continue a persistent Codex conversation in the DM
- Mention the app in a channel message to turn that message into the Codex thread root
- Reply in an existing Codex thread without re-mentioning the app once the thread has state

## Notes

- If `slack.allowed_user_ids` or `NUNTIUS_SLACK_ALLOWED_USER_IDS` is set, only those Slack users can talk to the app.
- If `slack.admin_user_ids` or `NUNTIUS_SLACK_ADMIN_USER_IDS` is set, only those users can run `/codexadmin`.
- Slash-command status/help/reset replies are ephemeral, similar to the Discord interaction flow.
- Slash-command ask/bind in a normal channel creates a dedicated Slack thread starter message first.
- Channel mentions start Codex inside a thread rooted on the user's message.
- Once a thread is bound to a repo, later replies in that thread go straight to the bound worker session until `/codex bind` or `/codex reset` changes the state.
- Worker progress stays in one updateable Slack status message where possible instead of spamming the thread.
- `reloadconfig` reloads the bridge config and repository registry in-process.
- `restart` only exits the current process. Use systemd, Docker restart policy, or another supervisor to bring it back up.
- Listener host/port changes still require restarting the process.
