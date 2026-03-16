import { formatCodexNetworkAccess as formatCodexNetworkAccessLabel } from "./codex-network-access.js";
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
      scope: "worker" | "binding" | "context" | "all";
    }
  | {
      kind: "interrupt";
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
      case "interrupt":
        await publisher.publishCompleted(turn, {
          text: buildInterruptMessage(await this.bridge.interruptConversation(turn))
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
    case "clear":
      return {
        kind: "reset",
        scope: head === "clear" ? "context" : parseResetScope(tail[0])
      };
    case "interrupt":
    case "stop":
      return {
        kind: "interrupt"
      };
    default:
      return {
        kind: "conversation",
        text: rest
      };
  }
}

function parseResetScope(raw: string | undefined): "worker" | "binding" | "context" | "all" {
  if (raw === "worker" || raw === "binding" || raw === "context" || raw === "all") {
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
    "/codex reset [worker|binding|context|all]",
    "/codex interrupt  -> interrupt the active Codex turn in this conversation",
    "/codex clear      -> clear Codex session history but keep the current repo binding",
    "/codex <message>  -> if a repo is bound, send it straight to that worker; otherwise send it to the handler",
    "plain text         -> follows the same route inside an existing conversation"
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
    `- Plain-text routing: ${
      status.binding.activeRepository ? "direct to the bound worker session" : "through the handler session"
    }`
  );
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

function buildResetMessage(scope: "worker" | "binding" | "context" | "all"): string {
  switch (scope) {
    case "worker":
      return "Reset the worker Codex session for this conversation.";
    case "binding":
      return "Cleared the repository binding for this conversation.";
    case "context":
      return "Cleared Codex context for this conversation and kept the current repository binding.";
    case "all":
      return "Cleared the whole conversation state for this thread.";
  }
}

function buildInterruptMessage(result: {
  status: "idle" | "requested" | "pending";
  actor?: "handler" | "worker";
  repositoryId?: string;
}): string {
  const target =
    result.actor === "worker"
      ? `worker turn${result.repositoryId ? ` for "${result.repositoryId}"` : ""}`
      : "Codex turn";

  switch (result.status) {
    case "requested":
      return `Interrupt requested for the active ${target}.`;
    case "pending":
      return `An interrupt is already pending for the active ${target}.`;
    case "idle":
      return "No active Codex turn is running in this conversation.";
  }
}

function formatCodexNetworkAccess(binding: {
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
} | undefined): string {
  return formatCodexNetworkAccessLabel(binding);
}
