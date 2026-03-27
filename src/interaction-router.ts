import { localize, resolveConversationLanguage } from "./conversation-language.js";
import { formatCodexNetworkAccess as formatCodexNetworkAccessLabel } from "./codex-network-access.js";
import type { ConversationLanguage, InboundTurn } from "./domain.js";
import type { CodexBridgeService, ConversationStatus } from "./service.js";
import type { TurnPublisher } from "./turn-publisher.js";

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
      case "help": {
        const language = await this.resolveLanguage(turn);
        await publisher.publishCompleted(turn, {
          text: buildHelpMessage(language)
        }, language);
        return;
      }
      case "status": {
        const status = await this.bridge.getConversationStatus(turn);
        const language = resolveConversationLanguage({
          binding: status.binding,
          text: turn.text
        });
        await publisher.publishCompleted(turn, {
          text: formatStatus(status, language)
        }, language);
        return;
      }
      case "repos": {
        const status = await this.bridge.getConversationStatus(turn);
        const language = resolveConversationLanguage({
          binding: status.binding,
          text: turn.text
        });
        await publisher.publishCompleted(turn, {
          text: formatRepositories(status, language)
        }, language);
        return;
      }
      case "bind": {
        const binding = await this.bridge.bindConversation(turn, command.repositoryId);
        const bindLanguage = resolveConversationLanguage({
          binding,
          text: turn.text
        });
        await publisher.publishCompleted(turn, {
          text: buildBindMessage(binding, bindLanguage)
        }, bindLanguage);
        return;
      }
      case "reset": {
        const language = await this.resolveLanguage(turn);
        await this.bridge.resetState(turn, command.scope);
        await publisher.publishCompleted(turn, {
          text: buildResetMessage(command.scope, language)
        }, language);
        return;
      }
      case "interrupt": {
        const language = await this.resolveLanguage(turn);
        await publisher.publishCompleted(turn, {
          text: buildInterruptMessage(await this.bridge.interruptConversation(turn), language)
        }, language);
        return;
      }
    }
  }

  private async resolveLanguage(turn: InboundTurn): Promise<ConversationLanguage> {
    const status = await this.bridge.getConversationStatus(turn);
    return resolveConversationLanguage({
      binding: status.binding,
      text: turn.text
    });
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

function buildHelpMessage(language: ConversationLanguage): string {
  return [
    localize(language, {
      en: "Codex bridge commands:",
      zh: "Codex bridge 命令："
    }),
    "/codex status",
    "/codex repos",
    "/codex bind <repo-id>",
    "/codex reset [worker|binding|context|all]",
    localize(language, {
      en: "/codex interrupt  -> interrupt the active Codex turn in this conversation",
      zh: "/codex interrupt  -> 中断当前会话里的活动 Codex turn"
    }),
    localize(language, {
      en: "/codex clear      -> clear Codex session history but keep the current repo binding",
      zh: "/codex clear      -> 清除 Codex 会话历史，但保留当前仓库绑定"
    }),
    localize(language, {
      en: "/codex <message>  -> if a repo is bound, send it straight to that worker; otherwise send it to the handler",
      zh: "/codex <message>  -> 若已绑定仓库则直接发送给 worker，否则发送给 handler"
    }),
    localize(language, {
      en: "plain text         -> follows the same route inside an existing conversation",
      zh: "普通文本           -> 在已有会话中遵循同样的路由规则"
    }),
    localize(language, {
      en: 'natural language   -> the handler can interpret repo-routing requests like "work on <repo-id>"',
      zh: '自然语言           -> handler 可以理解“切换到 <repo-id>”这类仓库路由请求'
    })
  ].join("\n");
}

function formatStatus(status: ConversationStatus, language: ConversationLanguage): string {
  const lines = [
    localize(language, {
      en: "Conversation status:",
      zh: "会话状态："
    })
  ];

  if (!status.binding) {
    lines.push(localize(language, {
      en: "- No conversation state yet.",
      zh: "- 当前还没有会话状态。"
    }));
    lines.push(
      localize(language, {
        en: `- Available repos: ${formatAvailableRepos(status, language)}`,
        zh: `- 可用仓库：${formatAvailableRepos(status, language)}`
      })
    );
    return lines.join("\n");
  }

  const none = localize(language, {
    en: "none",
    zh: "无"
  });
  lines.push(
    localize(language, {
      en: `- Handler session: ${status.binding.handlerSessionId ?? none}`,
      zh: `- Handler 会话：${status.binding.handlerSessionId ?? none}`
    })
  );
  lines.push(
    localize(language, {
      en: `- Bound repo: ${status.binding.activeRepository?.repositoryId ?? none}`,
      zh: `- 已绑定仓库：${status.binding.activeRepository?.repositoryId ?? none}`
    })
  );
  lines.push(
    localize(language, {
      en: `- Worker session: ${status.binding.activeRepository?.workerSessionId ?? none}`,
      zh: `- Worker 会话：${status.binding.activeRepository?.workerSessionId ?? none}`
    })
  );
  lines.push(
    localize(language, {
      en: `- Plain-text routing: ${
        status.binding.activeRepository ? "direct to the bound worker session" : "through the handler session"
      }`,
      zh: `- 普通文本路由：${
        status.binding.activeRepository ? "直接发送到已绑定的 worker session" : "通过 handler session"
      }`
    })
  );
  lines.push(
    localize(language, {
      en: `- Codex network access: ${formatCodexNetworkAccess(status.binding.activeRepository, language)}`,
      zh: `- Codex 网络访问：${formatCodexNetworkAccess(status.binding.activeRepository, language)}`
    })
  );
  lines.push(
    localize(language, {
      en: `- Available repos: ${formatAvailableRepos(status, language)}`,
      zh: `- 可用仓库：${formatAvailableRepos(status, language)}`
    })
  );
  return lines.join("\n");
}

function formatRepositories(status: ConversationStatus, language: ConversationLanguage): string {
  return localize(language, {
    en: `Available repositories: ${formatAvailableRepos(status, language)}`,
    zh: `可用仓库：${formatAvailableRepos(status, language)}`
  });
}

function formatAvailableRepos(status: ConversationStatus, language: ConversationLanguage): string {
  if (status.availableRepositories.length === 0) {
    return localize(language, {
      en: "none",
      zh: "无"
    });
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
}, language: ConversationLanguage): string {
  if (!binding.activeRepository) {
    return localize(language, {
      en: "The conversation is not bound to a repository.",
      zh: "当前会话尚未绑定仓库。"
    });
  }

  const networkAccess = formatCodexNetworkAccess(binding.activeRepository, language);
  return localize(language, {
    en: `Bound this conversation to "${binding.activeRepository.repositoryId}" (${binding.activeRepository.sandboxMode}, Codex network access: ${networkAccess}).`,
    zh: `已将当前会话绑定到 "${binding.activeRepository.repositoryId}"（${binding.activeRepository.sandboxMode}，Codex 网络访问：${networkAccess}）。`
  });
}

function buildResetMessage(
  scope: "worker" | "binding" | "context" | "all",
  language: ConversationLanguage
): string {
  switch (scope) {
    case "worker":
      return localize(language, {
        en: "Reset the worker Codex session for this conversation.",
        zh: "已重置当前会话的 worker Codex session。"
      });
    case "binding":
      return localize(language, {
        en: "Cleared the repository binding for this conversation.",
        zh: "已清除当前会话的仓库绑定。"
      });
    case "context":
      return localize(language, {
        en: "Cleared Codex context for this conversation and kept the current repository binding.",
        zh: "已清除当前会话的 Codex 上下文，并保留当前仓库绑定。"
      });
    case "all":
      return localize(language, {
        en: "Cleared the whole conversation state for this thread.",
        zh: "已清除当前线程的全部会话状态。"
      });
  }
}

function buildInterruptMessage(result: {
  status: "idle" | "requested" | "pending";
  actor?: "handler" | "worker";
  repositoryId?: string;
}, language: ConversationLanguage): string {
  const target =
    result.actor === "worker"
      ? localize(language, {
          en: `worker turn${result.repositoryId ? ` for "${result.repositoryId}"` : ""}`,
          zh: `worker turn${result.repositoryId ? `（仓库 "${result.repositoryId}"）` : ""}`
        })
      : localize(language, {
          en: "Codex turn",
          zh: "Codex turn"
        });

  switch (result.status) {
    case "requested":
      return localize(language, {
        en: `Interrupt requested for the active ${target}.`,
        zh: `已请求中断当前活动的 ${target}。`
      });
    case "pending":
      return localize(language, {
        en: `An interrupt is already pending for the active ${target}.`,
        zh: `当前活动的 ${target} 已经有一个待处理的中断请求。`
      });
    case "idle":
      return localize(language, {
        en: "No active Codex turn is running in this conversation.",
        zh: "当前会话里没有正在运行的 Codex turn。"
      });
  }
}

function formatCodexNetworkAccess(binding: {
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
} | undefined, language: ConversationLanguage): string {
  return formatCodexNetworkAccessLabel(binding, language);
}
