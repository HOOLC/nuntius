import type { RepositoryTarget } from "./config.js";
import type { ConversationBinding, InboundTurn } from "./domain.js";

export type HandlerDecision =
  | {
      action: "reply";
      message: string;
    }
  | {
      action: "bind_repo";
      repositoryId: string;
      message?: string;
      continueWithWorkerPrompt?: string;
    }
  | {
      action: "delegate";
      workerPrompt: string;
      message?: string;
    }
  | {
      action: "reset";
      scope: "worker" | "binding" | "context" | "all";
      message?: string;
    };

export function buildHandlerUserPrompt(input: {
  turn: InboundTurn;
  state: ConversationBinding;
  availableRepositories: RepositoryTarget[];
  requireExplicitRepositorySelection: boolean;
}): string {
  const { turn, state, availableRepositories, requireExplicitRepositorySelection } = input;
  const lines = [
    "You are the handler Codex session for an IM bridge thread that is not currently routed straight to a bound worker session.",
    "You decide whether to reply directly, bind a repository, or reset state before repo-scoped work continues in the bound worker session.",
    "Reply with exactly one JSON object and no markdown.",
    "",
    "JSON protocol:",
    '- {"action":"reply","message":"..."}',
    '- {"action":"bind_repo","repositoryId":"repo-id","message":"optional","continueWithWorkerPrompt":"optional"}',
    '- {"action":"reset","scope":"worker|binding|context|all","message":"optional"}',
    "",
    "Rules:",
    "- One thread may have at most one active repository binding at a time.",
    "- Do not silently switch repositories.",
    "- Repository switching stays explicit: use bind_repo before any work should move to a different repository.",
    "- Once a repository is bound, later plain-text thread replies bypass you and go straight to that worker session.",
    "- If no repository is bound and the user asks for repo work, ask which repository to use unless it is already explicit.",
    "- Use bind_repo with continueWithWorkerPrompt when the user explicitly names a repository and also wants immediate repo work.",
    "- Use reply for clarification, conversational answers, repo questions, and status-style answers.",
    `- Explicit repository selection required: ${String(requireExplicitRepositorySelection)}.`,
    "",
    "Conversation state:",
    `- Platform: ${turn.platform}`,
    `- Scope: ${turn.scope}`,
    `- User: ${turn.userDisplayName ?? turn.userId} (${turn.userId})`,
    `- Handler session exists: ${String(Boolean(state.handlerSessionId))}`,
    `- Active repository: ${state.activeRepository?.repositoryId ?? "none"}`,
    `- Worker session exists: ${String(Boolean(state.activeRepository?.workerSessionId))}`,
    `- Available repositories: ${formatRepositoryList(availableRepositories)}`,
    "",
    "Latest user message:",
    turn.text
  ];

  return lines.join("\n");
}

export function parseHandlerDecision(rawText: string): HandlerDecision {
  const parsed = JSON.parse(extractJsonObject(rawText)) as unknown;
  if (!isRecord(parsed) || typeof parsed.action !== "string") {
    throw new Error("Handler response did not contain a valid action.");
  }

  switch (parsed.action) {
    case "reply":
      return {
        action: "reply",
        message: readRequiredString(parsed, "message")
      };
    case "bind_repo":
      return {
        action: "bind_repo",
        repositoryId: readRequiredString(parsed, "repositoryId"),
        message: readOptionalString(parsed, "message"),
        continueWithWorkerPrompt: readOptionalString(parsed, "continueWithWorkerPrompt")
      };
    case "delegate":
      return {
        action: "delegate",
        workerPrompt: readRequiredString(parsed, "workerPrompt"),
        message: readOptionalString(parsed, "message")
      };
    case "reset":
      return {
        action: "reset",
        scope: readResetScope(parsed.scope),
        message: readOptionalString(parsed, "message")
      };
    default:
      throw new Error(`Unsupported handler action: ${parsed.action}.`);
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

function formatRepositoryList(repositories: RepositoryTarget[]): string {
  if (repositories.length === 0) {
    return "none";
  }

  return repositories.map((repository) => repository.id).join(", ");
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
