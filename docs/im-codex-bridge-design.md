# IM to Codex Bridge Design

## Goal

Allow Slack, Discord, and Feishu users to talk to Codex conversationally, while still supporting real repo-scoped coding work.

The key design choice is:

- the IM thread can start in a conversational handler session before any repository is bound
- repo-scoped coding work runs in a separate worker Codex session bound to one repository target
- once a thread is bound, later plain-text replies go straight to that worker session
- bind/reset operations stay explicit so repository switching does not happen implicitly

This still gives you a more natural chat UX than a command-only bridge. The user can say things like:

- "work on nuntius in this thread"
- "check why CI is failing"
- "actually switch to api-server"
- "summarize what you changed"

The handler is only needed while the thread is still unbound. After binding, the worker session owns the repo-scoped conversation directly.

## Codex Surfaces

This design uses the locally available Codex app server over stdio:

- `codex app-server`
- `thread/start` and `thread/resume`
- `turn/start` and `turn/interrupt`

That is enough for both optional handler sessions and persistent worker sessions while keeping the bridge in control of interrupts and approval callbacks.

The current bridge runtime also supports a bridge-level yolo override:

- `bridge.yolo_mode = true` or unset: force all handler and worker turns to `danger-full-access` with `approvalPolicy: never`
- `bridge.yolo_mode = false`: honor the configured handler and repository sandbox/approval settings

## Core Model

Each IM conversation thread keeps two layers of state:

### 1. Handler Session

This is the conversational front-end used before a repository is bound, or after the binding is explicitly reset.

Responsibilities:

- talk naturally with the user
- understand intent
- ask which repo to use when needed
- decide when a repo must be bound before work can continue
- decide when to bind or reset
- ask clarifying questions before a worker session should start

### 2. Worker Session

This is the repo-scoped execution session.

Responsibilities:

- inspect code
- edit files
- run tests
- perform reviews
- answer repo-specific technical questions

The worker is bound to one configured repository target at a time.

## Thread Semantics

One chat thread maps to:

- zero or one handler Codex session
- zero or one active repository binding
- zero or one active worker Codex session for that binding

That means:

- the thread can be conversational even before a repo is chosen
- once a repo is bound, later plain-text replies in that thread reuse the same worker session directly
- switching repos is explicit and clears the old worker session

## Architecture

```mermaid
flowchart LR
    Slack[Slack Adapter]
    Discord[Discord Adapter]
    Feishu[Feishu Adapter]
    Queue[Per-Thread Queue]
    Store[(Conversation Store)]
    Orchestrator[Bridge Orchestrator]
    Handler[Handler Codex Session]
    Worker[Worker Codex Session]

    Slack --> Queue
    Discord --> Queue
    Feishu --> Queue
    Queue --> Orchestrator
    Orchestrator --> Store
    Orchestrator --> Handler
    Orchestrator --> Worker
    Worker --> Orchestrator
    Orchestrator --> Slack
    Orchestrator --> Discord
    Orchestrator --> Feishu
```

## Conversation Flow

### User Turn

1. The adapter normalizes the IM message into an `InboundTurn`.
2. The bridge loads the persisted thread binding.
3. If a repository is already bound, the bridge resumes or creates that worker session directly.
4. If no repository is bound, the bridge resumes or creates the handler session and asks it for a structured decision in JSON.

Possible handler decisions:

- `reply`
- `bind_repo`
- `reset`

### Direct Reply

If the handler returns `reply`, the bridge posts that message to Slack or Discord.

Use this for:

- clarification questions
- general conversation
- status answers
- repo selection prompts

### Bind Repo

If the handler returns `bind_repo`, the bridge:

1. validates the repo ID against configured targets
2. updates the thread binding
3. clears the old worker session if the repo changed
4. optionally runs a worker task immediately if the handler included `continueWithWorkerPrompt`
5. posts the worker output back to the thread directly instead of routing it through the handler again

### Direct Worker Follow-up

If a repository is already bound, later plain-text thread replies skip the handler and the bridge:

1. resumes or creates the worker Codex session for the bound repo
2. runs the repo-scoped task
3. posts the worker output back to the thread directly

This is the critical pattern: once a repo is bound, the user talks to that worker session directly. The handler is not in the steady-state reply path anymore.

## State Model

The persisted thread state should look like this:

```ts
type ConversationBinding = {
  key: ConversationKey;
  handlerSessionId?: string;
  activeRepository?: {
    repositoryId: string;
    repositoryPath: string;
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    model?: string;
    workerSessionId?: string;
    updatedAt: string;
  };
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};
```

Important rules:

- `handlerSessionId` survives ordinary repo resets unless the user explicitly resets the whole thread
- `handlerSessionId` is only used while the thread is unbound
- `workerSessionId` is valid only for the active repository binding
- changing repositories clears the old `workerSessionId`

## Handler Protocol

Because the Codex CLI session is not exposing arbitrary custom tools here, the bridge uses a strict JSON protocol between the handler and the orchestrator.

Expected handler output:

```json
{"action":"reply","message":"Which repo should I use for this thread?"}
```

```json
{"action":"bind_repo","repositoryId":"nuntius","message":"Bound this thread to nuntius."}
```

```json
{"action":"reset","scope":"worker","message":"Cleared the worker session for this thread."}
```

The bridge must validate this JSON. If parsing fails, it should treat that as a handler failure and retry or surface an error.

## Repository Binding Model

Repository choice is thread context, not per-message context.

Recommended behavior:

- no repo bound: the handler can converse and ask questions, but cannot start repo work until the repository is explicit
- repo bound: normal plain-text replies go directly to the worker session for that repository
- user asks to switch repos: the user should do that explicitly with `bind_repo` or `/codex bind`, which updates the thread binding and clears the old worker session

This is the right place for conversational repo selection:

- user: "work in nuntius in this thread"
- handler: bind repo to `nuntius`
- user: "look at the latest test failures"
- bridge: route the message straight to the `nuntius` worker

## Security Model

Users never provide filesystem paths.

Use a configured registry of allowed repositories:

```json
[
  {
    "id": "nuntius",
    "path": "/srv/repos/nuntius",
    "sandboxMode": "workspace-write",
    "codexNetworkAccessWorkspacePath": "/tmp/nuntius-network/nuntius",
    "approvalPolicy": "never",
    "allowChannels": ["slack:T123:C456", "discord:G123:C999"]
  }
]
```

Unless a repository explicitly disables it, nuntius launches worker turns with `codex --search`.
For `workspace-write` workers it also sets `-c sandbox_workspace_write.network_access=true`, then
derives a dedicated artifacts workspace when none is configured. If the host Codex runtime or OS
policy still blocks outbound access, the worker should fail explicitly instead of silently acting
as if the web request succeeded. End-to-end access still requires the host environment to let the
Codex CLI reach `chatgpt.com` and to let worker tools resolve/connect to remote hosts such as
`github.com`.

Rules:

- the handler may mention only configured repository IDs
- the bridge enforces channel and user access checks
- yolo mode is enabled by default and forces `danger-full-access` plus `approvalPolicy: never` for all Codex turns
- set `bridge.yolo_mode = false` if you want to fall back to the per-handler and per-repository sandbox policy model
- Codex network access should use a dedicated workspace for fetched artifacts and remain disableable per target
- Codex CLI overrides for networked worker tasks should be explicit and reviewed per target

## Slack Shape

Recommended Slack UX:

- use slash commands for explicit entrypoints like `/codex`
- allow ordinary thread replies after the thread exists
- keep one Codex conversation per Slack thread

Example:

1. `/codex work on nuntius`
2. bridge creates the thread and binds `nuntius`
3. later thread replies go to the same worker session for `nuntius`

Useful explicit commands:

- `/codex status`
- `/codex reset`
- `/codex bind nuntius`

Those commands are optional convenience. The main UX can still be conversational.

## Discord Shape

Recommended Discord UX:

- use slash commands for thread creation and explicit operations
- keep normal follow-up interaction inside the created thread or DM
- prefer slash commands over privileged free-form message parsing outside that thread

Example:

1. `/codex start prompt:"work on nuntius"`
2. bridge creates the thread and binds `nuntius`
3. later replies inside that thread continue the same worker session

## Operational Requirements

### Queueing

All turns for one thread must execute serially.

Without this:

- handler turns can interleave
- worker runs can race
- repo rebinding can happen mid-turn

### Observability

Track:

- `conversation_key`
- `handler_session_id`
- `repository_id`
- `worker_session_id`
- queue wait
- handler latency
- worker latency
- handler parse failures

### Failure Handling

Expected failure classes:

- invalid handler JSON
- repo access denied
- worker failure
- handler failure after worker completion
- Slack or Discord postback failure

Recovery approach:

- preserve the thread state even if one turn fails
- allow explicit reset of worker or whole thread
- keep raw handler and worker outputs in logs for debugging

## Delivery Plan

### Phase 1

- implement the handler/worker conversation store
- implement the JSON handler protocol
- implement the orchestrator loop
- keep file-backed persistence

### Phase 2

- wire Slack and Discord runtimes
- add explicit convenience commands like `status`, `bind`, and `reset`

### Phase 3

- improve retry behavior for invalid handler JSON
- add message chunking and attachment support
- move persistence to Postgres

## References

- Slack slash commands: https://docs.slack.dev/interactivity/implementing-slash-commands/
- Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode/
- Discord interactions: https://docs.discord.com/developers/interactions/receiving-and-responding
- Discord gateway intents: https://docs.discord.com/developers/events/gateway
