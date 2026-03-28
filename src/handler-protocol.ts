import { formatAttachmentsForPrompt } from "./attachments.js";
import { describeConversationLanguage } from "./conversation-language.js";
import type { RepositoryTarget } from "./config.js";
import type { ConversationBinding, ConversationLanguage, InboundTurn } from "./domain.js";

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
    "If you need bridge control, include one or more action tags anywhere in your reply.",
    "",
    "Action tags:",
    "- [[ACTION:BIND(repo-id)]]",
    '- [[ACTION:SCHEDULE({"repositoryId":"repo-id","schedule":"every 1 hour","taskPrompt":"check status"})]]',
    "- [[ACTION:DELEGATE(worker prompt)]]",
    "- [[ACTION:RESET(worker|binding|context|all)]]",
    "",
    "Rules:",
    "- If no bridge control is needed, send normal text with no action tags.",
    "- Action tags are stripped before the visible reply is sent to the user.",
    "- Multiple action tags are allowed. If immediate repo work is needed, emit BIND before DELEGATE.",
    "- One thread may have at most one active repository binding at a time.",
    "- Do not silently switch repositories.",
    "- Repository switching stays explicit: use BIND before any work should move to a different repository.",
    "- Once a repository is bound, later plain-text thread replies bypass you and go straight to that worker session.",
    "- Scheduled task creation is handled here in the top-level handler session; do not bind the thread just to create a scheduled task unless the user also wants live repo work in this thread.",
    "- If no repository is bound and the user asks for repo work, ask which repository to use unless it is already explicit.",
    '- Treat conversational control phrases like "work on <repo-id>", "switch to <repo-id>", or "bind this thread to <repo-id>" as explicit repository-binding requests.',
    '- When the user says "work on <repo-id>" without a concrete task, emit [[ACTION:BIND(repo-id)]] and keep the visible reply short. Do not invent repo work.',
    '- When the user explicitly names a repository and also wants immediate repo work, emit [[ACTION:BIND(repo-id)]] followed by [[ACTION:DELEGATE(worker prompt)]].',
    '- When the user wants a recurring or scheduled background task, emit [[ACTION:SCHEDULE(...)]] with repositoryId, a canonical schedule string like "every 1 hour", and a concise taskPrompt.',
    "- If the repository or schedule for a scheduled task request is ambiguous, ask a clarification question instead of guessing.",
    '- For conversational requests like "what repo is this bound to?", "what repos are available?", or "how do I use this?", answer with reply using the current state below instead of asking for more detail.',
    '- For conversational reset requests like "reset this thread", "clear context", or "start over", emit RESET with the closest matching scope.',
    "- Use reply for clarification, conversational answers, repo questions, and status-style answers.",
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

  if (trimmed.includes("[[ACTION:")) {
    return parseTaggedHandlerDecision(rawText);
  }

  const legacyDecision = parseLegacyHandlerDecision(rawText);
  if (legacyDecision) {
    return legacyDecision;
  }

  return {
    message: trimmed,
    actions: []
  };
}

function parseTaggedHandlerDecision(rawText: string): HandlerDecision {
  const taggedActions = scanTaggedActions(rawText);
  const message = stripTaggedActions(rawText, taggedActions);
  return {
    message: message || undefined,
    actions: taggedActions.map((taggedAction) => taggedAction.action)
  };
}

function parseLegacyHandlerDecision(rawText: string): HandlerDecision | undefined {
  const trimmed = rawText.trim();
  if (!looksLikeLegacyJson(trimmed)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(extractJsonObject(rawText)) as unknown;
    if (!isRecord(parsed) || typeof parsed.action !== "string") {
      return undefined;
    }

    switch (parsed.action) {
      case "reply":
        return {
          message: readRequiredString(parsed, "message"),
          actions: []
        };
      case "bind_repo": {
        const actions: HandlerControlAction[] = [
          {
            action: "bind_repo",
            repositoryId: readRequiredString(parsed, "repositoryId")
          }
        ];
        const continueWithWorkerPrompt = readOptionalString(parsed, "continueWithWorkerPrompt");
        if (continueWithWorkerPrompt) {
          actions.push({
            action: "delegate",
            workerPrompt: continueWithWorkerPrompt
          });
        }
        return {
          message: readOptionalString(parsed, "message"),
          actions
        };
      }
      case "schedule_task":
        return {
          message: readOptionalString(parsed, "message"),
          actions: [
            {
              action: "schedule_task",
              repositoryId: readRequiredString(parsed, "repositoryId"),
              schedule: readRequiredString(parsed, "schedule"),
              taskPrompt: readRequiredString(parsed, "taskPrompt")
            }
          ]
        };
      case "delegate":
        return {
          message: readOptionalString(parsed, "message"),
          actions: [
            {
              action: "delegate",
              workerPrompt: readRequiredString(parsed, "workerPrompt")
            }
          ]
        };
      case "reset":
        return {
          message: readOptionalString(parsed, "message"),
          actions: [
            {
              action: "reset",
              scope: readResetScope(parsed.scope)
            }
          ]
        };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function extractJsonObject(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("Handler response did not contain a JSON object.");
}

function looksLikeLegacyJson(trimmed: string): boolean {
  return trimmed.startsWith("{") || /^```(?:json)?\s*/i.test(trimmed);
}

interface TaggedHandlerAction {
  start: number;
  end: number;
  action: HandlerControlAction;
}

function scanTaggedActions(rawText: string): TaggedHandlerAction[] {
  const actions: TaggedHandlerAction[] = [];
  let cursor = 0;

  while (cursor < rawText.length) {
    const start = rawText.indexOf("[[ACTION:", cursor);
    if (start < 0) {
      break;
    }

    const actionNameStart = start + "[[ACTION:".length;
    const openParen = rawText.indexOf("(", actionNameStart);
    if (openParen < 0) {
      throw new Error("Malformed handler action tag.");
    }

    const actionName = rawText.slice(actionNameStart, openParen).trim().toUpperCase();
    let depth = 1;
    let index = openParen + 1;

    while (index < rawText.length && depth > 0) {
      const character = rawText[index];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
      index += 1;
    }

    if (depth !== 0 || rawText.slice(index, index + 2) !== "]]") {
      throw new Error("Malformed handler action tag.");
    }

    const payload = rawText.slice(openParen + 1, index - 1).trim();
    actions.push({
      start,
      end: index + 2,
      action: parseTaggedAction(actionName, payload)
    });
    cursor = index + 2;
  }

  return actions;
}

function stripTaggedActions(rawText: string, actions: TaggedHandlerAction[]): string {
  if (actions.length === 0) {
    return rawText.trim();
  }

  let cursor = 0;
  const segments: string[] = [];
  for (const action of actions) {
    segments.push(rawText.slice(cursor, action.start));
    cursor = action.end;
  }
  segments.push(rawText.slice(cursor));

  return segments.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function parseTaggedAction(actionName: string, payload: string): HandlerControlAction {
  switch (actionName) {
    case "BIND":
      if (!payload) {
        throw new Error("BIND action requires a repository id.");
      }
      return {
        action: "bind_repo",
        repositoryId: payload
      };
    case "DELEGATE":
      if (!payload) {
        throw new Error("DELEGATE action requires a worker prompt.");
      }
      return {
        action: "delegate",
        workerPrompt: payload
      };
    case "SCHEDULE": {
      if (!payload) {
        throw new Error("SCHEDULE action requires a JSON payload.");
      }

      const parsed = JSON.parse(payload) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("SCHEDULE action payload must be an object.");
      }

      return {
        action: "schedule_task",
        repositoryId: readRequiredString(parsed, "repositoryId"),
        schedule: readRequiredString(parsed, "schedule"),
        taskPrompt: readRequiredString(parsed, "taskPrompt")
      };
    }
    case "RESET":
      return {
        action: "reset",
        scope: readResetScope(payload)
      };
    default:
      throw new Error(`Unsupported handler action tag: ${actionName}.`);
  }
}

function formatRepositoryCatalog(repositories: RepositoryTarget[]): string[] {
  if (repositories.length === 0) {
    return ["- none"];
  }

  return repositories.map((repository) =>
    `- ${repository.id} (sandbox=${repository.sandboxMode}, model=${repository.model ?? "default"}, codex_network_access=${repository.allowCodexNetworkAccess ? "enabled" : "disabled"})`
  );
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

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a string when provided.`);
  }

  return value;
}

function readResetScope(value: unknown): "worker" | "binding" | "context" | "all" {
  if (value === "worker" || value === "binding" || value === "context" || value === "all") {
    return value;
  }

  throw new Error("Expected reset scope to be one of worker, binding, context, or all.");
}
