# Service Management

nuntius can run as a user-level operating-system service through `nuntiusctl`.

Supported service managers:

- macOS: `launchd` user LaunchAgent
- Linux: `systemd --user`

Build first:

```bash
npm run build
```

## Install

Install a service that runs every configured integration:

```bash
npm run service:install -- --config /absolute/path/to/nuntius.toml
```

Install and start it immediately:

```bash
npm run service:install -- --config /absolute/path/to/nuntius.toml --start
```

Install a single integration instead of the combined launcher:

```bash
npm run service:install -- --integration discord --config /absolute/path/to/nuntius.toml
npm run service:install -- --integration feishu --config /absolute/path/to/nuntius.toml
npm run service:install -- --integration slack --config /absolute/path/to/nuntius.toml
```

Useful install options:

```bash
--name nuntius-production
--cwd /absolute/path/to/nuntius
--node /absolute/path/to/node
--env KEY=VALUE
```

On macOS, install writes:

```text
~/Library/LaunchAgents/com.hoolc.nuntius.plist
```

On Linux, install writes and enables:

```text
~/.config/systemd/user/nuntius.service
```

For Linux services that should run after reboot without an interactive login, enable user lingering outside nuntius:

```bash
loginctl enable-linger "$USER"
```

## Operate

```bash
npm run service:start
npm run service:stop
npm run service:restart
npm run service:status
npm run service:logs
npm run service:logs -- --follow
npm run service:uninstall
```

You can preview the generated service file without installing it:

```bash
npm run service -- print --config /absolute/path/to/nuntius.toml
```

## Notes

- The service runs `dist/index.js` by default.
- `--integration discord`, `--integration feishu`, and `--integration slack` run the matching bot entrypoint directly.
- The service uses the current Node executable unless `--node` is provided.
- If `--config` is omitted, the CLI uses `NUNTIUS_CONFIG_PATH` or `nuntius.toml` in the working directory.
- macOS logs are written under `~/Library/Logs/nuntius/` by default.
- Linux logs are read with `journalctl --user -u nuntius.service`.
