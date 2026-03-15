import type { InboundTurn } from "./domain.js";
import type { CodexBridgeService, ConversationStatus, TurnPublisher } from "./service.js";

export type BridgeCommand =
  | {
      kind: "conversation";
      text: string;
    }
  | {
      kind: "help";
    }
  | {
      kind: "status";
    }
  | {
      kind: "repos";
    }
  | {
      kind: "bind";
      repositoryId: string;
    }
  | {
      kind: "reset";
      scope: "worker" | "binding" | "all";
    };

export class InteractionRouter {
  constructor(private readonly bridge: CodexBridgeService) {}

  async handleTurn(turn: InboundTurn, publisher: TurnPublisher): Promise<void> {
    const command = parseBridgeCommand(turn.text);

    switch (command.kind) {
      case "conversation":
        await this.bridge.handleTurn(
          {
            ...turn,
            text: command.text
          },
          publisher
        );
        return;
      case "help":
        await publisher.publishCompleted(turn, {
          text: buildHelpMessage()
        });
        return;
      case "status":
        await publisher.publishCompleted(turn, {
          text: formatStatus(await this.bridge.getConversationStatus(turn))
        });
        return;
      case "repos":
        await publisher.publishCompleted(turn, {
          text: formatRepositories(await this.bridge.getConversationStatus(turn))
        });
        return;
      case "bind": {
        const binding = await this.bridge.bindConversation(turn, command.repositoryId);
        await publisher.publishCompleted(turn, {
          text: buildBindMessage(binding)
        });
        return;
      }
      case "reset":
        await this.bridge.resetState(turn, command.scope);
        await publisher.publishCompleted(turn, {
          text: buildResetMessage(command.scope)
        });
        return;
    }
  }
}

export function parseBridgeCommand(text: string): BridgeCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/codex")) {
    return {
      kind: "conversation",
      text: trimmed
    };
  }

  const rest = trimmed.slice("/codex".length).trim();
  if (!rest || rest === "help") {
    return {
      kind: "help"
    };
  }

  const parts = rest.split(/\s+/);
  const [head, ...tail] = parts;

  switch (head) {
    case "status":
      return {
        kind: "status"
      };
    case "repos":
      return {
        kind: "repos"
      };
    case "bind":
      if (tail[0]) {
        return {
          kind: "bind",
          repositoryId: tail[0]
        };
      }
      return {
        kind: "help"
      };
    case "reset":
      return {
        kind: "reset",
        scope: parseResetScope(tail[0])
      };
    default:
      return {
        kind: "conversation",
        text: rest
      };
  }
}

function parseResetScope(raw: string | undefined): "worker" | "binding" | "all" {
  if (raw === "worker" || raw === "binding" || raw === "all") {
    return raw;
  }

  return "all";
}

function buildHelpMessage(): string {
  return [
    "Codex bridge commands:",
    "/codex status",
    "/codex repos",
    "/codex bind <repo-id>",
    "/codex reset [worker|binding|all]",
    "/codex <message>  -> send the rest of the message into the conversational handler",
    "plain text         -> also goes to the conversational handler"
  ].join("\n");
}

function formatStatus(status: ConversationStatus): string {
  const lines = ["Conversation status:"];

  if (!status.binding) {
    lines.push("- No conversation state yet.");
    lines.push(`- Available repos: ${formatAvailableRepos(status)}`);
    return lines.join("\n");
  }

  lines.push(`- Handler session: ${status.binding.handlerSessionId ?? "none"}`);
  lines.push(`- Bound repo: ${status.binding.activeRepository?.repositoryId ?? "none"}`);
  lines.push(`- Worker session: ${status.binding.activeRepository?.workerSessionId ?? "none"}`);
  lines.push(
    `- Codex network access: ${formatCodexNetworkAccess(status.binding.activeRepository)}`
  );
  lines.push(`- Available repos: ${formatAvailableRepos(status)}`);
  return lines.join("\n");
}

function formatRepositories(status: ConversationStatus): string {
  return `Available repositories: ${formatAvailableRepos(status)}`;
}

function formatAvailableRepos(status: ConversationStatus): string {
  if (status.availableRepositories.length === 0) {
    return "none";
  }

  return status.availableRepositories.map((repository) => repository.id).join(", ");
}

function buildBindMessage(binding: {
  activeRepository?: {
    repositoryId: string;
    sandboxMode: string;
    allowCodexNetworkAccess?: boolean;
    codexNetworkAccessWorkspacePath?: string;
  };
}): string {
  if (!binding.activeRepository) {
    return "The conversation is not bound to a repository.";
  }

  const networkAccess = formatCodexNetworkAccess(binding.activeRepository);
  return `Bound this conversation to "${binding.activeRepository.repositoryId}" (${binding.activeRepository.sandboxMode}, Codex network access: ${networkAccess}).`;
}

function buildResetMessage(scope: "worker" | "binding" | "all"): string {
  switch (scope) {
    case "worker":
      return "Reset the worker Codex session for this conversation.";
    case "binding":
      return "Cleared the repository binding for this conversation.";
    case "all":
      return "Cleared the whole conversation state for this thread.";
  }
}

function formatCodexNetworkAccess(binding: {
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
} | undefined): string {
  if (!binding?.allowCodexNetworkAccess || !binding.codexNetworkAccessWorkspacePath) {
    return "disabled";
  }

  return `enabled (${binding.codexNetworkAccessWorkspacePath})`;
}
