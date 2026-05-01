import {
  formatAttachmentsForPrompt,
  mergeAttachments
} from "./attachments.js";
import { detectConversationLanguage, localize } from "./conversation-language.js";
import type { BridgeConfig, RepositoryTarget } from "./config.js";
import { hasCodexNetworkAccess } from "./codex-network-access.js";
import type {
  ApprovalPolicy,
  ConversationBinding,
  ConversationLanguage,
  HandlerSessionBinding,
  InboundTurn,
  OutboundMessage,
  RepositoryBinding,
  SandboxMode
} from "./domain.js";
import { toConversationKey } from "./domain.js";
import { buildImReplyFormatRules } from "./im-response-format.js";
import { sanitizeUserFacingText } from "./user-facing-text.js";
import { WAKE_AFTER_TOOL_USAGE } from "./worker-protocol.js";

const HANDLER_SESSION_CONFIG_VERSION = 3;
const WORKER_SESSION_CONFIG_VERSION = 2;

export function createConversationBinding(turn: InboundTurn): ConversationBinding {
  const now = new Date().toISOString();
  return {
    key: toConversationKey(turn),
    language: detectConversationLanguage(turn.text),
    createdByUserId: turn.userId,
    createdAt: now,
    updatedAt: now
  };
}

export function bindRepository(
  binding: ConversationBinding,
  repository: RepositoryTarget,
  boundByUserId: string = binding.activeRepository?.boundByUserId ?? binding.createdByUserId
): ConversationBinding {
  const now = new Date().toISOString();

  return {
    ...binding,
    activeRepository: deriveRepositoryBinding(binding.activeRepository, repository, now, boundByUserId),
    updatedAt: now
  };
}

export function refreshRepositoryBinding(
  binding: ConversationBinding,
  repository: RepositoryTarget
): ConversationBinding {
  const boundByUserId = binding.activeRepository?.boundByUserId ?? binding.createdByUserId;
  const nextActiveRepository = deriveRepositoryBinding(
    binding.activeRepository,
    repository,
    binding.activeRepository?.updatedAt ?? binding.updatedAt,
    boundByUserId,
    true
  );

  if (repositoryBindingsEquivalent(binding.activeRepository, nextActiveRepository)) {
    return binding;
  }

  const now = new Date().toISOString();
  return {
    ...binding,
    activeRepository: deriveRepositoryBinding(binding.activeRepository, repository, now, boundByUserId, true),
    updatedAt: now
  };
}

export function buildHandlerSessionConfig(config: BridgeConfig): HandlerSessionBinding {
  return {
    workspacePath: config.handlerWorkspacePath,
    sandboxMode: getEffectiveSessionSandboxMode(config.handlerSandboxMode, config.yoloMode),
    approvalPolicy: getEffectiveSessionApprovalPolicy(undefined, config.yoloMode),
    model: config.handlerModel,
    sessionConfigVersion: HANDLER_SESSION_CONFIG_VERSION
  };
}

export function shouldReuseHandlerSession(
  previous: HandlerSessionBinding | undefined,
  current: HandlerSessionBinding
): boolean {
  if (!previous) {
    return false;
  }

  return handlerSessionConfigsEqual(previous, current);
}

export function handlerSessionConfigsEqual(
  left: HandlerSessionBinding | undefined,
  right: HandlerSessionBinding | undefined
): boolean {
  return (
    left?.workspacePath === right?.workspacePath &&
    left?.sandboxMode === right?.sandboxMode &&
    left?.approvalPolicy === right?.approvalPolicy &&
    left?.model === right?.model &&
    left?.sessionConfigVersion === right?.sessionConfigVersion
  );
}

export function resetBinding(
  binding: ConversationBinding,
  scope: "worker" | "binding" | "context" | "all"
): ConversationBinding {
  const now = new Date().toISOString();

  if (scope === "all") {
    return {
      ...binding,
      handlerSessionId: undefined,
      handlerConfig: undefined,
      activeRepository: undefined,
      attachments: undefined,
      updatedAt: now
    };
  }

  if (scope === "binding") {
    return {
      ...binding,
      activeRepository: undefined,
      attachments: undefined,
      updatedAt: now
    };
  }

  if (scope === "context") {
    return {
      ...binding,
      handlerSessionId: undefined,
      handlerConfig: undefined,
      activeRepository: binding.activeRepository
        ? {
            ...binding.activeRepository,
            pendingWakeRequest: undefined,
            workerSessionId: undefined,
            updatedAt: now
          }
        : undefined,
      updatedAt: now
    };
  }

  return {
    ...binding,
    activeRepository: binding.activeRepository
      ? {
          ...binding.activeRepository,
          pendingWakeRequest: undefined,
          workerSessionId: undefined,
          updatedAt: now
        }
      : undefined,
    updatedAt: now
  };
}

export function buildResetMessage(
  scope: "worker" | "binding" | "context" | "all",
  language: ConversationLanguage
): string {
  switch (scope) {
    case "worker":
      return localize(language, {
        en: "Cleared the worker Codex session for this thread.",
        zh: "已清除当前线程的 worker Codex session。"
      });
    case "binding":
      return localize(language, {
        en: "Cleared the repository binding for this thread.",
        zh: "已清除当前线程的仓库绑定。"
      });
    case "context":
      return localize(language, {
        en: "Cleared Codex context for this thread and kept the current repository binding.",
        zh: "已清除当前线程的 Codex 上下文，并保留当前仓库绑定。"
      });
    case "all":
      return localize(language, {
        en: "Cleared the handler session and repository binding for this thread.",
        zh: "已清除当前线程的 handler session 和仓库绑定。"
      });
  }
}

export function touchBinding(binding: ConversationBinding): ConversationBinding {
  return {
    ...binding,
    updatedAt: new Date().toISOString()
  };
}

export function buildWorkerReply(output: string, language: ConversationLanguage): string {
  return (
    output.trim() ||
    localize(language, {
      en: "Codex completed the requested work.",
      zh: "Codex 已完成所请求的工作。"
    })
  );
}

export function clipMessage(
  text: string,
  maxChars: number,
  attachments: OutboundMessage["attachments"] | undefined,
  language: ConversationLanguage
): OutboundMessage {
  const sanitizedText = sanitizeUserFacingText(text);

  if (sanitizedText.length <= maxChars) {
    return {
      text: sanitizedText,
      truncated: false,
      attachments
    };
  }

  return {
    text: `${sanitizedText.slice(0, maxChars - 16)}\n\n${localize(language, {
      en: "[truncated...]",
      zh: "[内容已截断...]"
    })}`,
    truncated: true,
    attachments
  };
}

export function buildWorkerPrompt(
  binding: RepositoryBinding,
  turn: InboundTurn,
  workerPrompt: string
): string {
  const lines: string[] = [];

  if (hasCodexNetworkAccess(binding)) {
    lines.push(
      "Worker execution context:",
      `- Primary repository path: ${binding.repositoryPath}`,
      "- nuntius requested web access for this worker session by launching Codex with `--search`.",
      binding.sandboxMode === "workspace-write"
        ? "- nuntius also enabled outbound shell network access for the workspace-write sandbox via `-c sandbox_workspace_write.network_access=true`."
        : "",
      `- Use this workspace for cloned or downloaded artifacts that do not belong in the primary repository: ${binding.codexNetworkAccessWorkspacePath}`,
      "- Network-dependent commands may still fail if the host Codex runtime or OS policy blocks outbound access.",
      "- If outbound access is unavailable, stop and report the failure clearly instead of claiming you fetched remote data.",
      ""
    );
  }

  lines.push(
    "Native bridge tools available to this worker session:",
    `- ${WAKE_AFTER_TOOL_USAGE}`,
    "- Use `nuntius.wake_after` only when the task genuinely requires time to pass before you continue.",
    "- Bridge control is available only through native tool calls, not visible text.",
    "- Do not use handler-only routing tools such as bind_repo, delegate_to_worker, reset_thread, or schedule_task from worker sessions.",
    "- If the user asks to switch repositories or reset routing, tell them to use `/codex bind <repo-id>` or `/codex reset` instead.",
    "- Keep a short plain-text status update in your final reply when requesting a wake-up.",
    "- When the timer fires, nuntius resumes this same worker session in the background with a wake-up prompt.",
    "- Background wake-up turns are not automatically posted back to chat, so use them for waiting, polling, monitoring, and follow-up work.",
    "",
    ...buildImReplyFormatRules(turn.platform)
  );

  lines.push("User task:");
  lines.push(workerPrompt.trim() || "(The user sent attachments with no additional text.)");

  if (turn.attachments.length > 0) {
    lines.push(
      "",
      "Attachments visible to this turn:",
      ...formatAttachmentsForPrompt(turn.attachments),
      "",
      "If you modify an attached .doc or .docx file in place, or write a new .doc/.docx beside it in the same attachment directory, nuntius may send that file back to the user after this turn."
    );
  }

  return lines.filter(Boolean).join("\n");
}

export function listWorkerAddDirs(binding: RepositoryBinding): string[] | undefined {
  if (!hasCodexNetworkAccess(binding)) {
    return undefined;
  }

  return [binding.codexNetworkAccessWorkspacePath];
}

export function mergeAddDirs(...groups: Array<string[] | undefined>): string[] | undefined {
  const merged = [...new Set(groups.flatMap((group) => group ?? []))];
  return merged.length > 0 ? merged : undefined;
}

export function mergeBindingAttachments(
  binding: ConversationBinding,
  attachments: InboundTurn["attachments"]
): ConversationBinding {
  const nextAttachments = mergeAttachments(binding.attachments, attachments);
  if (attachmentsEqual(binding.attachments, nextAttachments)) {
    return binding;
  }

  return {
    ...binding,
    attachments: nextAttachments,
    updatedAt: new Date().toISOString()
  };
}

export function buildEffectiveTurn(
  turn: InboundTurn,
  binding: ConversationBinding
): InboundTurn {
  const attachments = mergeAttachments(binding.attachments, turn.attachments);
  if (attachmentsEqual(turn.attachments, attachments)) {
    return turn;
  }

  return {
    ...turn,
    attachments
  };
}

export function clearPendingWorkerWakeRequest(binding: ConversationBinding): ConversationBinding {
  if (!binding.activeRepository?.pendingWakeRequest) {
    return binding;
  }

  const now = new Date().toISOString();
  return {
    ...binding,
    activeRepository: {
      ...binding.activeRepository,
      pendingWakeRequest: undefined,
      updatedAt: now
    },
    updatedAt: now
  };
}

function deriveRepositoryBinding(
  previous: RepositoryBinding | undefined,
  repository: RepositoryTarget,
  updatedAt: string,
  boundByUserId: string,
  preserveLegacyBoundByUserId = false
): RepositoryBinding {
  const sandboxMode = repository.sandboxMode;
  const reuseWorkerSession = shouldReuseWorkerSession(
    previous,
    repository,
    boundByUserId,
    preserveLegacyBoundByUserId
  );

  return {
    repositoryId: repository.id,
    repositoryPath: repository.path,
    boundByUserId,
    sandboxMode,
    model: repository.model,
    approvalPolicy: repository.approvalPolicy,
    codexConfigOverrides: repository.codexConfigOverrides ?? [],
    allowCodexNetworkAccess: Boolean(repository.allowCodexNetworkAccess),
    codexNetworkAccessWorkspacePath: repository.codexNetworkAccessWorkspacePath,
    workerProtocolVersion: WORKER_SESSION_CONFIG_VERSION,
    workerSessionId: reuseWorkerSession ? previous?.workerSessionId : undefined,
    pendingWakeRequest: reuseWorkerSession ? previous?.pendingWakeRequest : undefined,
    updatedAt
  };
}

function shouldReuseWorkerSession(
  previous: RepositoryBinding | undefined,
  repository: RepositoryTarget,
  boundByUserId: string,
  preserveLegacyBoundByUserId: boolean
): boolean {
  if (!previous || previous.repositoryId !== repository.id) {
    return false;
  }

  const sandboxMode = repository.sandboxMode;
  const approvalPolicy = repository.approvalPolicy;
  const previousBoundByUserId =
    preserveLegacyBoundByUserId && previous.boundByUserId === undefined
      ? boundByUserId
      : previous.boundByUserId;

  return (
    previous.repositoryPath === repository.path &&
    previous.workerProtocolVersion === WORKER_SESSION_CONFIG_VERSION &&
    previousBoundByUserId === boundByUserId &&
    previous.sandboxMode === sandboxMode &&
    previous.model === repository.model &&
    previous.approvalPolicy === approvalPolicy &&
    Boolean(previous.allowCodexNetworkAccess) ===
      Boolean(repository.allowCodexNetworkAccess) &&
    previous.codexNetworkAccessWorkspacePath === repository.codexNetworkAccessWorkspacePath &&
    arraysEqual(previous.codexConfigOverrides, repository.codexConfigOverrides)
  );
}

function repositoryBindingsEquivalent(
  left: RepositoryBinding | undefined,
  right: RepositoryBinding | undefined
): boolean {
  return (
    left?.repositoryId === right?.repositoryId &&
    left?.repositoryPath === right?.repositoryPath &&
    left?.boundByUserId === right?.boundByUserId &&
    left?.sandboxMode === right?.sandboxMode &&
    left?.model === right?.model &&
    left?.approvalPolicy === right?.approvalPolicy &&
    left?.workerProtocolVersion === right?.workerProtocolVersion &&
    Boolean(left?.allowCodexNetworkAccess) === Boolean(right?.allowCodexNetworkAccess) &&
    left?.codexNetworkAccessWorkspacePath === right?.codexNetworkAccessWorkspacePath &&
    left?.workerSessionId === right?.workerSessionId &&
    left?.pendingWakeRequest?.id === right?.pendingWakeRequest?.id &&
    left?.pendingWakeRequest?.requestedAt === right?.pendingWakeRequest?.requestedAt &&
    left?.pendingWakeRequest?.dueAt === right?.pendingWakeRequest?.dueAt &&
    left?.pendingWakeRequest?.durationMs === right?.pendingWakeRequest?.durationMs &&
    arraysEqual(left?.codexConfigOverrides, right?.codexConfigOverrides)
  );
}

function getEffectiveSessionSandboxMode(
  sandboxMode: SandboxMode,
  yoloMode: boolean | undefined
): SandboxMode {
  if (yoloMode) {
    return "danger-full-access";
  }

  return sandboxMode;
}

function getEffectiveSessionApprovalPolicy(
  approvalPolicy: ApprovalPolicy | undefined,
  yoloMode: boolean | undefined
): ApprovalPolicy | undefined {
  if (yoloMode) {
    return "never";
  }

  return approvalPolicy;
}

function arraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function attachmentsEqual(
  left: ConversationBinding["attachments"],
  right: ConversationBinding["attachments"]
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((value, index) =>
    value.id === normalizedRight[index]?.id &&
    value.kind === normalizedRight[index]?.kind &&
    value.name === normalizedRight[index]?.name &&
    value.mimeType === normalizedRight[index]?.mimeType &&
    value.url === normalizedRight[index]?.url &&
    value.localPath === normalizedRight[index]?.localPath
  );
}
