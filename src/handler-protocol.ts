import { formatAttachmentsForPrompt } from "./attachments.js";
import type { CodexDynamicToolCall, CodexDynamicToolSpec } from "./codex-runner.js";
import { describeConversationLanguage } from "./conversation-language.js";
import type { RepositoryTarget } from "./config.js";
import type { ConversationBinding, ConversationLanguage, InboundTurn } from "./domain.js";
import { buildImReplyFormatRules } from "./im-response-format.js";

export const HANDLER_BRIDGE_TOOL_NAMESPACE = "nuntius";

export type HandlerControlAction =
  | {
      action: "bind_repo";
      repositoryId: string;
    }
  | {
      action: "schedule_task";
      repositoryId: string;
      schedule: string;
      taskPrompt: string;
    }
  | {
      action: "delegate";
      workerPrompt: string;
    }
  | {
      action: "reset";
      scope: "worker" | "binding" | "context" | "all";
    };

export interface HandlerDecision {
  message?: string;
  actions: HandlerControlAction[];
}

export function buildHandlerDynamicTools(): CodexDynamicToolSpec[] {
  return [
    {
      namespace: HANDLER_BRIDGE_TOOL_NAMESPACE,
      name: "bind_repo",
      description: [
        "Bind the current IM thread to a repository id.",
        "Use this only when the user explicitly selected a repository.",
        "If immediate repository work should continue, call delegate_to_worker after this tool."
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          repositoryId: {
            type: "string",
            description: "Repository id from the available repository catalog."
          }
        },
        required: ["repositoryId"],
        additionalProperties: false
      }
    },
    {
      namespace: HANDLER_BRIDGE_TOOL_NAMESPACE,
      name: "delegate_to_worker",
      description: [
        "Continue concrete repository work in the bound repo-scoped worker session.",
        "If no repository is bound yet, call bind_repo first."
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          workerPrompt: {
            type: "string",
            description: "Concise task prompt to send to the repo-scoped worker session."
          }
        },
        required: ["workerPrompt"],
        additionalProperties: false
      }
    },
    {
      namespace: HANDLER_BRIDGE_TOOL_NAMESPACE,
      name: "schedule_task",
      description: "Create a recurring background task for a repository without binding the live thread unless the user also requested live work.",
      inputSchema: {
        type: "object",
        properties: {
          repositoryId: {
            type: "string",
            description: "Repository id where the scheduled task should run."
          },
          schedule: {
            type: "string",
            description: 'Canonical cadence such as "every 1 hour".'
          },
          taskPrompt: {
            type: "string",
            description: "Concise description of the recurring work."
          }
        },
        required: ["repositoryId", "schedule", "taskPrompt"],
        additionalProperties: false
      }
    },
    {
      namespace: HANDLER_BRIDGE_TOOL_NAMESPACE,
      name: "reset_thread",
      description: "Reset bridge state for this IM thread using the closest scope requested by the user.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["worker", "binding", "context", "all"],
            description: "Reset scope."
          }
        },
        required: ["scope"],
        additionalProperties: false
      }
    }
  ];
}

export function parseHandlerToolCall(
  call: Pick<CodexDynamicToolCall, "namespace" | "tool" | "arguments">
): HandlerControlAction {
  if (call.namespace !== HANDLER_BRIDGE_TOOL_NAMESPACE) {
    throw new Error(
      `Unsupported handler bridge tool namespace: ${call.namespace ?? "none"}.`
    );
  }

  const args = readToolArguments(call.arguments);
  switch (call.tool) {
    case "bind_repo":
      return {
        action: "bind_repo",
        repositoryId: readRequiredString(args, "repositoryId")
      };
    case "delegate_to_worker":
      return {
        action: "delegate",
        workerPrompt: readRequiredString(args, "workerPrompt")
      };
    case "schedule_task":
      return {
        action: "schedule_task",
        repositoryId: readRequiredString(args, "repositoryId"),
        schedule: readRequiredString(args, "schedule"),
        taskPrompt: readRequiredString(args, "taskPrompt")
      };
    case "reset_thread":
      return {
        action: "reset",
        scope: readResetScope(args.scope)
      };
    default:
      throw new Error(`Unsupported handler bridge tool: ${call.tool}.`);
  }
}

export function buildHandlerUserPrompt(input: {
  turn: InboundTurn;
  state: ConversationBinding;
  availableRepositories: RepositoryTarget[];
  requireExplicitRepositorySelection: boolean;
  conversationLanguage: ConversationLanguage;
}): string {
  const {
    turn,
    state,
    availableRepositories,
    requireExplicitRepositorySelection,
    conversationLanguage
  } = input;
  const lines = [
    "You are the handler Codex session for an IM bridge thread that is not currently routed straight to a bound worker session.",
    "You decide whether to reply directly, create a scheduled task, bind a repository, or reset state before repo-scoped work continues in the bound worker session.",
    "Normal plain-text replies are allowed.",
    "If you need bridge control, call one or more native bridge tools instead of writing control syntax in the visible reply.",
    "",
    "Native bridge tools in the `nuntius` namespace:",
    "- `nuntius.bind_repo`",
    "- `nuntius.schedule_task`",
    "- `nuntius.delegate_to_worker`",
    "- `nuntius.reset_thread`",
    "",
    "Rules:",
    "- If no bridge control is needed, send normal text with no tool calls.",
    "- Multiple bridge tool calls are allowed. If immediate repo work is needed, call bind_repo before delegate_to_worker.",
    "- One thread may have at most one active repository binding at a time.",
    "- Do not silently switch repositories.",
    "- Repository switching stays explicit: call bind_repo before any work should move to a different repository.",
    "- Once a repository is bound, later plain-text thread replies bypass you and go straight to that worker session.",
    "- Scheduled task creation is handled here in the top-level handler session; do not bind the thread just to create a scheduled task unless the user also wants live repo work in this thread.",
    "- If no repository is bound and the user asks for repo work, ask which repository to use unless it is already explicit.",
    '- Treat conversational control phrases like "work on <repo-id>", "switch to <repo-id>", or "bind this thread to <repo-id>" as explicit repository-binding requests.',
    '- When the user says "work on <repo-id>" without a concrete task, call `nuntius.bind_repo` and keep the visible reply short. Do not invent repo work.',
    '- When the user explicitly names a repository and also wants immediate repo work, call `nuntius.bind_repo` followed by `nuntius.delegate_to_worker`.',
    "- If the user names a repository and a concrete task in the same message, do not stop after bind_repo. Bind first and delegate the task in the same reply.",
    "- Concrete repo work includes summaries, status checks, inspections, debugging, reviewing, test triage, code changes, and similar actionable requests.",
    '- Example: "Summarize arbitero\'s current status." -> call `nuntius.bind_repo` with repositoryId `arbitero`, then call `nuntius.delegate_to_worker` with workerPrompt "Summarize arbitero\'s current status.".',
    '- Example: "总结一下 arbitero 的现状。" -> call `nuntius.bind_repo` with repositoryId `arbitero`, then call `nuntius.delegate_to_worker` with workerPrompt "总结 arbitero 当前的现状。".',
    '- When the user wants a recurring or scheduled background task, call `nuntius.schedule_task` with repositoryId, a canonical schedule string like "every 1 hour", and a concise taskPrompt.',
    "- If the repository or schedule for a scheduled task request is ambiguous, ask a clarification question instead of guessing.",
    '- For conversational requests like "what repo is this bound to?", "what repos are available?", or "how do I use this?", answer with reply using the current state below instead of asking for more detail.',
    '- For conversational reset requests like "reset this thread", "clear context", or "start over", call `nuntius.reset_thread` with the closest matching scope.',
    "- Use reply for clarification, conversational answers, repo questions, and status-style answers.",
    ...buildImReplyFormatRules(turn.platform),
    `- Reply to the user in ${describeConversationLanguage(conversationLanguage)}.`,
    `- Explicit repository selection required: ${String(requireExplicitRepositorySelection)}.`,
    "",
    "Conversation state:",
    `- Platform: ${turn.platform}`,
    `- Scope: ${turn.scope}`,
    `- User: ${turn.userDisplayName ?? turn.userId} (${turn.userId})`,
    `- Preferred reply language: ${describeConversationLanguage(conversationLanguage)}`,
    `- Handler session exists: ${String(Boolean(state.handlerSessionId))}`,
    `- Active repository: ${state.activeRepository?.repositoryId ?? "none"}`,
    `- Worker session exists: ${String(Boolean(state.activeRepository?.workerSessionId))}`,
    "- Available repositories and settings:",
    ...formatRepositoryCatalog(availableRepositories),
    "",
    "Latest user message:",
    turn.text || "(no text)",
    "",
    "Attachments visible to this turn:",
    ...formatAttachmentsForPrompt(turn.attachments),
    "",
    "If attachments are listed with local paths, you may inspect them from those paths before deciding."
  ];

  return lines.join("\n");
}

export function parseHandlerDecision(rawText: string): HandlerDecision {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Handler response was empty.");
  }

  return {
    message: trimmed,
    actions: []
  };
}

function formatRepositoryCatalog(repositories: RepositoryTarget[]): string[] {
  if (repositories.length === 0) {
    return ["- none"];
  }

  return repositories.map((repository) =>
    `- ${repository.id} (sandbox=${repository.sandboxMode}, model=${repository.model ?? "default"}, codex_network_access=${repository.allowCodexNetworkAccess ? "enabled" : "disabled"})`
  );
}

function readToolArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error("Handler bridge tool arguments must be an object.");
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }

  return value;
}

function readResetScope(value: unknown): "worker" | "binding" | "context" | "all" {
  if (value === "worker" || value === "binding" || value === "context" || value === "all") {
    return value;
  }

  throw new Error("Expected reset scope to be one of worker, binding, context, or all.");
}
