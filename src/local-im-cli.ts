import process from "node:process";
import readline from "node:readline";

import { localize } from "./conversation-language.js";
import { formatCodexNetworkAccess } from "./codex-network-access.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import type {
  ConversationBinding,
  ConversationLanguage,
  InboundTurn,
  OutboundMessage
} from "./domain.js";
import { CodexBridgeService, type ConversationStatus } from "./service.js";
import type { TurnPublisher } from "./turn-publisher.js";

interface LocalChatState {
  platform: "slack" | "discord" | "feishu";
  workspaceId: string;
  channelId: string;
  threadId: string;
  userId: string;
  userDisplayName?: string;
}

async function main(): Promise<void> {
  const { bridge, router } = createBridgeRuntime();

  const state = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  printBanner(state);
  rl.setPrompt(renderPrompt(state));
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    const handledLocally = await handleLocalCommand(trimmed, state, bridge);
    if (!handledLocally) {
      const turn = buildTurn(state, line);
      await router.handleTurn(turn, new ConsolePublisher());
    }

    rl.setPrompt(renderPrompt(state));
    rl.prompt();
  }
}

function parseArgs(args: string[]): LocalChatState {
  const state: LocalChatState = {
    platform: "slack",
    workspaceId: "local",
    channelId: "general",
    threadId: "thread-1",
    userId: "user-1",
    userDisplayName: "local-user"
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];

    switch (value) {
      case "--platform":
        if (next === "slack" || next === "discord" || next === "feishu") {
          state.platform = next;
          index += 1;
        }
        break;
      case "--workspace":
        if (next) {
          state.workspaceId = next;
          index += 1;
        }
        break;
      case "--channel":
        if (next) {
          state.channelId = next;
          index += 1;
        }
        break;
      case "--thread":
        if (next) {
          state.threadId = next;
          index += 1;
        }
        break;
      case "--user":
        if (next) {
          state.userId = next;
          index += 1;
        }
        break;
      case "--name":
        if (next) {
          state.userDisplayName = next;
          index += 1;
        }
        break;
    }
  }

  return state;
}

function buildTurn(state: LocalChatState, text: string): InboundTurn {
  return {
    platform: state.platform,
    workspaceId: state.workspaceId,
    channelId: state.channelId,
    threadId: state.threadId,
    userId: state.userId,
    userDisplayName: state.userDisplayName,
    scope: "thread",
    text,
    attachments: [],
    receivedAt: new Date().toISOString()
  };
}

async function handleLocalCommand(
  text: string,
  state: LocalChatState,
  bridge: CodexBridgeService
): Promise<boolean> {
  if (!text.startsWith("/local")) {
    return false;
  }

  const [, command, ...rest] = text.split(/\s+/);

  switch (command) {
    case "help":
      printLocalHelp();
      return true;
    case "thread":
      if (rest[0]) {
        state.threadId = rest[0];
        console.log(`[local] active thread -> ${state.threadId}`);
      }
      return true;
    case "channel":
      if (rest[0]) {
        state.channelId = rest[0];
        console.log(`[local] active channel -> ${state.channelId}`);
      }
      return true;
    case "user":
      if (rest[0]) {
        state.userId = rest[0];
        console.log(`[local] active user -> ${state.userId}`);
      }
      return true;
    case "where":
      console.log(renderLocation(state));
      return true;
    case "state": {
      const status = await bridge.getConversationStatus(buildTurn(state, "/local state"));
      printConversationStatus(status);
      return true;
    }
    case "quit":
    case "exit":
      process.exit(0);
    default:
      printLocalHelp();
      return true;
  }
}

function printBanner(state: LocalChatState): void {
  console.log("Local IM simulator");
  console.log(renderLocation(state));
  console.log("Use plain text for conversation, `/codex ...` for bridge commands, `/local help` for local controls.");
}

function renderPrompt(state: LocalChatState): string {
  return `[${state.platform}:${state.channelId}:${state.threadId}]> `;
}

function renderLocation(state: LocalChatState): string {
  return `platform=${state.platform} workspace=${state.workspaceId} channel=${state.channelId} thread=${state.threadId} user=${state.userId}`;
}

function printLocalHelp(): void {
  console.log("Local simulator commands:");
  console.log("/local help");
  console.log("/local thread <id>");
  console.log("/local channel <id>");
  console.log("/local user <id>");
  console.log("/local where");
  console.log("/local state");
  console.log("/local quit");
}

function printConversationStatus(status: ConversationStatus): void {
  console.log("Conversation status:");
  console.log(`- handler session: ${status.binding?.handlerSessionId ?? "none"}`);
  console.log(`- bound repo: ${status.binding?.activeRepository?.repositoryId ?? "none"}`);
  console.log(`- worker session: ${status.binding?.activeRepository?.workerSessionId ?? "none"}`);
  console.log(`- Codex network access: ${formatCodexNetworkAccess(status.binding?.activeRepository)}`);
  console.log(
    `- available repos: ${
      status.availableRepositories.map((repository) => repository.id).join(", ") || "none"
    }`
  );
}

class ConsolePublisher implements TurnPublisher {
  async publishQueued(_: InboundTurn, language: ConversationLanguage): Promise<void> {
    console.log(
      `[queued] ${localize(language, {
        en: "queued behind the active turn for this thread",
        zh: "当前线程已有进行中的 turn，本条消息已进入队列"
      })}`
    );
  }

  async publishStarted(
    _: InboundTurn,
    binding: ConversationBinding,
    note: string | undefined,
    _language: ConversationLanguage
  ): Promise<void> {
    const repositoryId = binding.activeRepository?.repositoryId ?? "none";
    const workerSessionId = binding.activeRepository?.workerSessionId ?? "new";
    const networkAccess = binding.activeRepository
      ? formatCodexNetworkAccess(binding.activeRepository)
      : "disabled";
    const prefix = note ? `${note}\n` : "";
    console.log(
      `[worker] ${prefix}repo=${repositoryId} worker_session=${workerSessionId} network_access=${networkAccess}`
    );
  }

  async publishProgress(
    _: InboundTurn,
    message: string,
    _language: ConversationLanguage
  ): Promise<void> {
    console.log(`[progress] ${message}`);
  }

  async publishCompleted(
    _: InboundTurn,
    message: OutboundMessage,
    _language: ConversationLanguage
  ): Promise<void> {
    console.log(`[codex]\n${message.text}`);
  }

  async publishInterrupted(
    _: InboundTurn,
    message: string,
    _language: ConversationLanguage
  ): Promise<void> {
    console.log(`[interrupted]\n${message}`);
  }

  async publishFailed(
    _: InboundTurn,
    errorMessage: string,
    _language: ConversationLanguage
  ): Promise<void> {
    console.log(`[error]\n${errorMessage}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
