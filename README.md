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

## What It Can Do

nuntius lets people use Codex from the chat tool they already work in.

You can use it to:

- ask Codex questions in Slack, Discord, or Feishu
- bind a chat thread to one repository and keep working in the same thread
- have Codex inspect code, edit files, run checks, and summarize changes
- continue work over multiple turns without re-explaining the repo every time
- create recurring background tasks from plain language
- let a worker wait and resume later for monitoring or polling jobs

## What It Feels Like

You do not need to start with a rigid command-only flow.

A typical conversation looks like this:

1. Start naturally in chat.
2. Let Codex figure out whether it needs a repository.
3. Bind the thread to the right repo when needed.
4. Keep replying in the same thread while Codex continues the work.

That means the same thread can begin as a general conversation and then become a persistent repo work thread.

## Example Things To Ask

- "Work on nuntius in this thread and explain how the routing works."
- "Bind this thread to api-server and find out why CI is failing."
- "Review the recent changes and tell me the biggest risks."
- "Summarize what you changed in plain English."
- "Every hour, check the deployment status in arbitero and keep a running log."
- "Wait ten minutes and continue when the maintenance window opens."

## Why People Use It

- It keeps Codex close to the place where the team already talks.
- It avoids copy-pasting repo context into every turn.
- It works for both quick questions and longer coding sessions.
- It supports both live interactive work and background follow-up tasks.

## Supported Integrations

- Slack
- Discord
- Feishu

Setup guides:

- [docs/slack-setup.md](docs/slack-setup.md)
- [docs/discord-setup.md](docs/discord-setup.md)
- [docs/feishu-setup.md](docs/feishu-setup.md)
- [docs/service-management.md](docs/service-management.md)

## Manual Setup

If you want to set it up yourself instead of delegating to Codex:

1. Install dependencies with `npm install`.
2. Copy the example config files and fill in your credentials and repository paths.
3. Build the project with `npm run build`.
4. Start the integration you want to use.

Useful commands:

```bash
npm run build
npm run slack:start
npm run discord:start
npm run feishu:start
npm run start
npm run service:install
npm run service:start
npm run service:status
```

If you want a local dry run without a real chat platform:

```bash
npm run im:local
```

For actual configuration details, use:

- [config/nuntius.example.toml](config/nuntius.example.toml)
- [config/repository-registry.example.toml](config/repository-registry.example.toml)
- [README.agent.md](README.agent.md)
- [docs/service-management.md](docs/service-management.md)

## Further Reading

- [docs/im-codex-bridge-design.md](docs/im-codex-bridge-design.md)
- [docs/slack-setup.md](docs/slack-setup.md)
- [docs/discord-setup.md](docs/discord-setup.md)
- [docs/feishu-setup.md](docs/feishu-setup.md)
- [docs/service-management.md](docs/service-management.md)
- [README.agent.md](README.agent.md)
