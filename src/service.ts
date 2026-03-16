import { promises as fs } from "node:fs";
import path from "node:path";

import type { BridgeConfig, RepositoryTarget } from "./config.js";
import {
  buildCodexNetworkAccessFailureMessage,
  hasCodexNetworkAccess
} from "./codex-network-access.js";
import type {
  CodexEvent,
  ConversationBinding,
  HandlerSessionBinding,
  InboundTurn,
  OutboundMessage,
  RepositoryBinding
} from "./domain.js";
import { conversationKeyToId, toConversationKey } from "./domain.js";
import type { CodexRunner } from "./codex-runner.js";
import {
  buildHandlerUserPrompt,
  parseHandlerDecision,
  type HandlerDecision
} from "./handler-protocol.js";
import type { SerialTurnQueue } from "./serial-turn-queue.js";
import type { SessionStore } from "./session-store.js";

export interface TurnPublisher {
  publishQueued(turn: InboundTurn): Promise<void>;
  publishStarted(turn: InboundTurn, binding: ConversationBinding, note?: string): Promise<void>;
  publishProgress(turn: InboundTurn, message: string): Promise<void>;
  publishCompleted(turn: InboundTurn, message: OutboundMessage): Promise<void>;
  publishFailed(turn: InboundTurn, errorMessage: string): Promise<void>;
}

export interface ConversationStatus {
  binding?: ConversationBinding;
  availableRepositories: RepositoryTarget[];
}

export interface SessionReconciliationResult {
  totalBindings: number;
  updatedBindings: number;
  clearedHandlerSessions: number;
  clearedWorkerSessions: number;
  droppedRepositoryBindings: number;
}

interface HandlerRunResult {
  binding: ConversationBinding;
  decision: HandlerDecision;
}

export class CodexBridgeService {
  constructor(
    private readonly config: BridgeConfig,
    private readonly sessionStore: SessionStore,
    private readonly queue: SerialTurnQueue,
    private readonly runner: CodexRunner
  ) {}

  async handleTurn(turn: InboundTurn, publisher: TurnPublisher): Promise<void> {
    const conversationKey = toConversationKey(turn);
    const conversationId = conversationKeyToId(conversationKey);

    if (this.queue.isBusy(conversationId)) {
      await publisher.publishQueued(turn);
    }

    await this.queue.run(conversationId, async () => {
      try {
        const storedBinding =
          (await this.sessionStore.get(conversationKey)) ?? createConversationBinding(turn);
        let binding = this.refreshBindingForTurn(turn, storedBinding);

        if (binding !== storedBinding) {
          await this.sessionStore.upsert(binding);
        }

        if (binding.activeRepository) {
          const outcome = await this.completeWorkerTurn(turn, binding, turn.text, publisher);
          await this.sessionStore.upsert(outcome.binding);
          await publisher.publishCompleted(turn, outcome.finalMessage);
          return;
        }

        let finalMessage: OutboundMessage | undefined;

        for (let step = 0; step < this.config.maxHandlerStepsPerTurn; step += 1) {
          const handlerRun = await this.runHandlerTurn(turn, binding, publisher);
          binding = handlerRun.binding;
          await this.sessionStore.upsert(binding);

          const outcome = await this.applyHandlerDecision(turn, binding, handlerRun.decision, publisher);
          binding = outcome.binding;
          await this.sessionStore.upsert(binding);

          if (outcome.finalMessage) {
            finalMessage = outcome.finalMessage;
            break;
          }
        }

        if (!finalMessage) {
          throw new Error("Handler exceeded the maximum number of orchestration steps for one turn.");
        }

        await publisher.publishCompleted(turn, finalMessage);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "The bridge hit an unknown failure.";
        await publisher.publishFailed(turn, errorMessage);
      }
    });
  }

  async reconcileSessionBindings(): Promise<SessionReconciliationResult> {
    const bindings = await this.sessionStore.list();
    const summary: SessionReconciliationResult = {
      totalBindings: bindings.length,
      updatedBindings: 0,
      clearedHandlerSessions: 0,
      clearedWorkerSessions: 0,
      droppedRepositoryBindings: 0
    };

    for (const binding of bindings) {
      const reconciled = await this.queue.run(
        conversationKeyToId(binding.key),
        async () => {
          const current = await this.sessionStore.get(binding.key);
          if (!current) {
            return undefined;
          }

          const next = this.reconcileBindingWithCurrentConfig(current);
          if (next.changed) {
            await this.sessionStore.upsert(next.binding);
          }

          return next;
        }
      );

      if (!reconciled) {
        continue;
      }

      if (!reconciled.changed) {
        continue;
      }

      summary.updatedBindings += 1;
      summary.clearedHandlerSessions += reconciled.clearedHandlerSessions;
      summary.clearedWorkerSessions += reconciled.clearedWorkerSessions;
      summary.droppedRepositoryBindings += reconciled.droppedRepositoryBindings;
    }

    return summary;
  }

  async resetConversation(turn: InboundTurn): Promise<void> {
    await this.resetState(turn, "all");
  }

  async resetState(turn: InboundTurn, scope: "worker" | "binding" | "context" | "all"): Promise<void> {
    const conversationKey = toConversationKey(turn);
    const conversationId = conversationKeyToId(conversationKey);

    await this.queue.run(conversationId, async () => {
      if (scope === "all") {
        await this.sessionStore.delete(conversationKey);
        return;
      }

      const existing = await this.sessionStore.get(conversationKey);
      if (!existing) {
        return;
      }

      await this.sessionStore.upsert(resetBinding(existing, scope));
    });
  }

  async bindConversation(turn: InboundTurn, repositoryId: string): Promise<ConversationBinding> {
    const conversationKey = toConversationKey(turn);
    const conversationId = conversationKeyToId(conversationKey);

    return this.queue.run(conversationId, async () => {
      const existing = (await this.sessionStore.get(conversationKey)) ?? createConversationBinding(turn);
      const refreshed = this.refreshHandlerSessionBinding(existing);
      const repository = this.resolveRepository(turn, repositoryId);
      const binding = bindRepository(refreshed, repository);

      await this.sessionStore.upsert(binding);
      return binding;
    });
  }

  async getConversationStatus(turn: InboundTurn): Promise<ConversationStatus> {
    return {
      binding: await this.sessionStore.get(toConversationKey(turn)),
      availableRepositories: this.listAccessibleRepositories(turn)
    };
  }

  private async runHandlerTurn(
    turn: InboundTurn,
    binding: ConversationBinding,
    publisher: TurnPublisher
  ): Promise<HandlerRunResult> {
    const prompt = buildHandlerUserPrompt({
      turn,
      state: binding,
      availableRepositories: this.listAccessibleRepositories(turn),
      requireExplicitRepositorySelection: this.config.requireExplicitRepositorySelection
    });

    const progress = new CodexRunProgressReporter(turn, publisher, {
      actor: "handler",
      announceTurnStart: true
    });

    let result;
    try {
      progress.start();
      result = await this.runner.runTurn({
        prompt,
        repositoryPath: this.config.handlerWorkspacePath,
        sandboxMode: this.config.handlerSandboxMode,
        sessionId: binding.handlerSessionId,
        model: this.config.handlerModel,
        onEvent: (event) => {
          progress.onEvent(event);
        }
      });
    } finally {
      await progress.stop();
    }

    return {
      binding: {
        ...binding,
        handlerSessionId: result.sessionId ?? binding.handlerSessionId,
        handlerConfig: buildHandlerSessionConfig(this.config),
        updatedAt: new Date().toISOString()
      },
      decision: parseHandlerDecision(result.responseText)
    };
  }

  private async applyHandlerDecision(
    turn: InboundTurn,
    binding: ConversationBinding,
    decision: HandlerDecision,
    publisher: TurnPublisher
  ): Promise<{ binding: ConversationBinding; finalMessage?: OutboundMessage }> {
    switch (decision.action) {
      case "reply":
        return {
          binding: touchBinding(binding),
          finalMessage: clipMessage(decision.message, this.config.maxResponseChars)
        };
      case "bind_repo": {
        const repository = this.resolveRepository(turn, decision.repositoryId);
        let nextBinding = bindRepository(binding, repository);

        if (!decision.continueWithWorkerPrompt) {
          return {
            binding: nextBinding,
            finalMessage: clipMessage(
              decision.message ?? `This thread is now bound to repository "${repository.id}".`,
              this.config.maxResponseChars
            )
          };
        }

        return this.completeWorkerTurn(
          turn,
          nextBinding,
          decision.continueWithWorkerPrompt,
          publisher,
          decision.message
        );
      }
      case "delegate": {
        if (!binding.activeRepository) {
          return {
            binding: touchBinding(binding),
            finalMessage: clipMessage(
              this.buildMissingRepositoryMessage(turn),
              this.config.maxResponseChars
            )
          };
        }

        // Keep accepting legacy delegate decisions from existing handler sessions, but route
        // the user-facing reply straight from the worker output.
        return this.completeWorkerTurn(
          turn,
          binding,
          decision.workerPrompt,
          publisher,
          decision.message
        );
      }
      case "reset":
        return {
          binding: resetBinding(binding, decision.scope),
          finalMessage: clipMessage(
            decision.message ?? buildResetMessage(decision.scope),
            this.config.maxResponseChars
          )
        };
      default:
        return {
          binding,
          finalMessage: clipMessage("Unsupported handler decision.", this.config.maxResponseChars)
        };
    }
  }

  private async completeWorkerTurn(
    turn: InboundTurn,
    binding: ConversationBinding,
    workerPrompt: string,
    publisher: TurnPublisher,
    note?: string
  ): Promise<{ binding: ConversationBinding; finalMessage: OutboundMessage }> {
    const currentBinding = this.refreshActiveRepositoryBinding(turn, binding);
    await this.sessionStore.upsert(currentBinding);
    await publisher.publishStarted(turn, currentBinding, note);

    const workerResult = await this.runWorkerTurn(turn, currentBinding, workerPrompt, publisher);

    return {
      binding: workerResult.binding,
      finalMessage: clipMessage(buildWorkerReply(workerResult.output), this.config.maxResponseChars)
    };
  }

  private async runWorkerTurn(
    turn: InboundTurn,
    binding: ConversationBinding,
    workerPrompt: string,
    publisher: TurnPublisher
  ): Promise<{ binding: ConversationBinding; output: string }> {
    if (!binding.activeRepository) {
      throw new Error("A worker turn was requested without an active repository binding.");
    }

    const worker = binding.activeRepository;
    const prompt = buildWorkerPrompt(worker, workerPrompt);
    const progress = new CodexRunProgressReporter(turn, publisher, {
      actor: "worker",
      repositoryId: worker.repositoryId,
      announceTurnStart: false
    });

    if (hasCodexNetworkAccess(worker)) {
      await fs.mkdir(worker.codexNetworkAccessWorkspacePath, { recursive: true });
    }

    let result;
    try {
      progress.start();
      result = await this.runner.runTurn({
        prompt,
        repositoryPath: worker.repositoryPath,
        sandboxMode: worker.sandboxMode,
        sessionId: worker.workerSessionId,
        model: worker.model,
        approvalPolicy: worker.approvalPolicy,
        searchEnabled: hasCodexNetworkAccess(worker),
        networkAccessEnabled: hasCodexNetworkAccess(worker),
        addDirs: listWorkerAddDirs(worker),
        configOverrides: worker.codexConfigOverrides,
        onEvent: (event) => {
          progress.onEvent(event);
        }
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(buildCodexNetworkAccessFailureMessage(worker, error.message));
      }

      throw error;
    } finally {
      await progress.stop();
    }

    return {
      binding: {
        ...binding,
        activeRepository: {
          ...worker,
          workerSessionId: result.sessionId ?? worker.workerSessionId,
          updatedAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      },
      output: result.responseText
    };
  }

  private resolveRepository(turn: InboundTurn, repositoryId: string): RepositoryTarget {
    const repository = this.config.repositoryTargets.find((candidate) => candidate.id === repositoryId);

    if (!repository) {
      throw new Error(`Unknown repository target: ${repositoryId}.`);
    }

    if (!this.hasRepositoryAccess(turn, repository)) {
      throw new Error("This user or channel is not allowed to access the selected repository target.");
    }

    return repository;
  }

  private listAccessibleRepositories(turn: InboundTurn): RepositoryTarget[] {
    return this.config.repositoryTargets.filter((candidate) =>
      this.hasRepositoryAccess(turn, candidate)
    );
  }

  private hasRepositoryAccess(turn: InboundTurn, repository: RepositoryTarget): boolean {
    const channelScope = `${turn.platform}:${turn.workspaceId}:${turn.channelId}`;

    if (repository.allowUsers && !repository.allowUsers.includes(turn.userId)) {
      return false;
    }

    if (repository.allowChannels && !repository.allowChannels.includes(channelScope)) {
      return false;
    }

    return true;
  }

  private buildMissingRepositoryMessage(turn: InboundTurn): string {
    const available = this.listAccessibleRepositories(turn).map((repository) => repository.id);

    if (available.length === 0) {
      return "No repositories are available to this user in this channel.";
    }

    return [
      "No repository is bound to this conversation.",
      "Use `/codex bind <repo-id>` to bind one first, or mention the repository explicitly so the handler can bind it.",
      `Available repositories: ${available.join(", ")}.`
    ].join(" ");
  }

  private refreshActiveRepositoryBinding(
    turn: InboundTurn,
    binding: ConversationBinding
  ): ConversationBinding {
    if (!binding.activeRepository) {
      return this.refreshHandlerSessionBinding(binding);
    }

    return refreshRepositoryBinding(
      this.refreshHandlerSessionBinding(binding),
      this.resolveRepository(turn, binding.activeRepository.repositoryId)
    );
  }

  private refreshBindingForTurn(
    turn: InboundTurn,
    binding: ConversationBinding
  ): ConversationBinding {
    if (!binding.activeRepository) {
      return this.refreshHandlerSessionBinding(binding);
    }

    return this.refreshActiveRepositoryBinding(turn, binding);
  }

  private refreshHandlerSessionBinding(binding: ConversationBinding): ConversationBinding {
    const nextHandlerConfig = buildHandlerSessionConfig(this.config);
    const shouldKeepSession = shouldReuseHandlerSession(binding.handlerConfig, nextHandlerConfig);
    const nextHandlerSessionId = shouldKeepSession ? binding.handlerSessionId : undefined;
    const shouldTrackConfig = Boolean(nextHandlerSessionId) || Boolean(binding.handlerConfig);
    const nextHandlerConfigValue = shouldTrackConfig ? nextHandlerConfig : binding.handlerConfig;

    if (
      binding.handlerSessionId === nextHandlerSessionId &&
      handlerSessionConfigsEqual(binding.handlerConfig, nextHandlerConfigValue)
    ) {
      return binding;
    }

    return {
      ...binding,
      handlerSessionId: nextHandlerSessionId,
      handlerConfig: nextHandlerConfigValue,
      updatedAt: new Date().toISOString()
    };
  }

  private reconcileBindingWithCurrentConfig(binding: ConversationBinding): {
    binding: ConversationBinding;
    changed: boolean;
    clearedHandlerSessions: number;
    clearedWorkerSessions: number;
    droppedRepositoryBindings: number;
  } {
    const originalHandlerSessionId = binding.handlerSessionId;
    const originalWorkerSessionId = binding.activeRepository?.workerSessionId;
    const originalRepositoryId = binding.activeRepository?.repositoryId;

    let nextBinding = this.refreshHandlerSessionBinding(binding);

    if (nextBinding.activeRepository) {
      const repository = this.resolveRepositoryById(nextBinding.activeRepository.repositoryId);

      if (repository) {
        nextBinding = refreshRepositoryBinding(nextBinding, repository);
      } else {
        nextBinding = {
          ...nextBinding,
          activeRepository: undefined,
          updatedAt: new Date().toISOString()
        };
      }
    }

    return {
      binding: nextBinding,
      changed: nextBinding !== binding,
      clearedHandlerSessions: originalHandlerSessionId && !nextBinding.handlerSessionId ? 1 : 0,
      clearedWorkerSessions:
        Boolean(originalWorkerSessionId) && !nextBinding.activeRepository?.workerSessionId ? 1 : 0,
      droppedRepositoryBindings:
        Boolean(originalRepositoryId) && !nextBinding.activeRepository ? 1 : 0
    };
  }

  private resolveRepositoryById(repositoryId: string): RepositoryTarget | undefined {
    return this.config.repositoryTargets.find((candidate) => candidate.id === repositoryId);
  }
}

function createConversationBinding(turn: InboundTurn): ConversationBinding {
  const now = new Date().toISOString();
  return {
    key: toConversationKey(turn),
    createdByUserId: turn.userId,
    createdAt: now,
    updatedAt: now
  };
}

function bindRepository(
  binding: ConversationBinding,
  repository: RepositoryTarget
): ConversationBinding {
  const now = new Date().toISOString();

  return {
    ...binding,
    activeRepository: deriveRepositoryBinding(binding.activeRepository, repository, now),
    updatedAt: now
  };
}

function refreshRepositoryBinding(
  binding: ConversationBinding,
  repository: RepositoryTarget
): ConversationBinding {
  const nextActiveRepository = deriveRepositoryBinding(
    binding.activeRepository,
    repository,
    binding.activeRepository?.updatedAt ?? binding.updatedAt
  );

  if (repositoryBindingsEquivalent(binding.activeRepository, nextActiveRepository)) {
    return binding;
  }

  const now = new Date().toISOString();
  return {
    ...binding,
    activeRepository: deriveRepositoryBinding(binding.activeRepository, repository, now),
    updatedAt: now
  };
}

function deriveRepositoryBinding(
  previous: RepositoryBinding | undefined,
  repository: RepositoryTarget,
  updatedAt: string
): RepositoryBinding {
  return {
    repositoryId: repository.id,
    repositoryPath: repository.path,
    sandboxMode: repository.sandboxMode,
    model: repository.model,
    approvalPolicy: repository.approvalPolicy,
    codexConfigOverrides: repository.codexConfigOverrides ?? [],
    allowCodexNetworkAccess: Boolean(repository.allowCodexNetworkAccess),
    codexNetworkAccessWorkspacePath: repository.codexNetworkAccessWorkspacePath,
    workerSessionId: shouldReuseWorkerSession(previous, repository) ? previous?.workerSessionId : undefined,
    updatedAt
  };
}

function shouldReuseWorkerSession(
  previous: RepositoryBinding | undefined,
  repository: RepositoryTarget
): boolean {
  if (!previous || previous.repositoryId !== repository.id) {
    return false;
  }

  return (
    previous.repositoryPath === repository.path &&
    previous.sandboxMode === repository.sandboxMode &&
    previous.model === repository.model &&
    previous.approvalPolicy === repository.approvalPolicy &&
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
    left?.sandboxMode === right?.sandboxMode &&
    left?.model === right?.model &&
    left?.approvalPolicy === right?.approvalPolicy &&
    Boolean(left?.allowCodexNetworkAccess) === Boolean(right?.allowCodexNetworkAccess) &&
    left?.codexNetworkAccessWorkspacePath === right?.codexNetworkAccessWorkspacePath &&
    left?.workerSessionId === right?.workerSessionId &&
    arraysEqual(left?.codexConfigOverrides, right?.codexConfigOverrides)
  );
}

function buildHandlerSessionConfig(config: BridgeConfig): HandlerSessionBinding {
  return {
    workspacePath: config.handlerWorkspacePath,
    sandboxMode: config.handlerSandboxMode,
    model: config.handlerModel
  };
}

function shouldReuseHandlerSession(
  previous: HandlerSessionBinding | undefined,
  current: HandlerSessionBinding
): boolean {
  if (!previous) {
    return false;
  }

  return handlerSessionConfigsEqual(previous, current);
}

function handlerSessionConfigsEqual(
  left: HandlerSessionBinding | undefined,
  right: HandlerSessionBinding | undefined
): boolean {
  return (
    left?.workspacePath === right?.workspacePath &&
    left?.sandboxMode === right?.sandboxMode &&
    left?.model === right?.model
  );
}

function resetBinding(
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
      updatedAt: now
    };
  }

  if (scope === "binding") {
    return {
      ...binding,
      activeRepository: undefined,
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
          workerSessionId: undefined,
          updatedAt: now
        }
      : undefined,
    updatedAt: now
  };
}

function buildResetMessage(scope: "worker" | "binding" | "context" | "all"): string {
  switch (scope) {
    case "worker":
      return "Cleared the worker Codex session for this thread.";
    case "binding":
      return "Cleared the repository binding for this thread.";
    case "context":
      return "Cleared Codex context for this thread and kept the current repository binding.";
    case "all":
      return "Cleared the handler session and repository binding for this thread.";
  }
}

function touchBinding(binding: ConversationBinding): ConversationBinding {
  return {
    ...binding,
    updatedAt: new Date().toISOString()
  };
}

function buildWorkerReply(output: string): string {
  return output.trim() ? output : "Codex completed the requested work.";
}

function clipMessage(text: string, maxChars: number): OutboundMessage {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false
    };
  }

  return {
    text: `${text.slice(0, maxChars - 16)}\n\n[truncated...]`,
    truncated: true
  };
}

function buildWorkerPrompt(binding: RepositoryBinding, workerPrompt: string): string {
  if (!hasCodexNetworkAccess(binding)) {
    return workerPrompt;
  }

  return [
    "Worker execution context:",
    `- Primary repository path: ${binding.repositoryPath}`,
    "- nuntius requested web access for this worker session by launching Codex with `--search`.",
    binding.sandboxMode === "workspace-write"
      ? "- nuntius also enabled outbound shell network access for the workspace-write sandbox via `-c sandbox_workspace_write.network_access=true`."
      : undefined,
    `- Use this workspace for cloned or downloaded artifacts that do not belong in the primary repository: ${binding.codexNetworkAccessWorkspacePath}`,
    "- Network-dependent commands may still fail if the host Codex runtime or OS policy blocks outbound access.",
    "- If outbound access is unavailable, stop and report the failure clearly instead of claiming you fetched remote data.",
    "",
    "User task:",
    workerPrompt
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function listWorkerAddDirs(binding: RepositoryBinding): string[] | undefined {
  if (!hasCodexNetworkAccess(binding)) {
    return undefined;
  }

  return [binding.codexNetworkAccessWorkspacePath];
}

function arraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

const PROGRESS_HEARTBEAT_MS = 20_000;
const PROGRESS_DUPLICATE_WINDOW_MS = 4_000;
const MAX_PROGRESS_MESSAGES_PER_RUN = 14;

type CodexProgressActor = "handler" | "worker";

interface CodexProgressContext {
  actor: CodexProgressActor;
  repositoryId?: string;
  announceTurnStart: boolean;
}

class CodexRunProgressReporter {
  private heartbeatTimer?: NodeJS.Timeout;
  private pending = Promise.resolve();
  private lastMessage?: string;
  private lastPublishedAt = 0;
  private sentCount = 0;
  private bufferedAgentMessage?: string;
  private sawTurnCompleted = false;
  private lastActivityAt = Date.now();

  constructor(
    private readonly turn: InboundTurn,
    private readonly publisher: TurnPublisher,
    private readonly context: CodexProgressContext
  ) {}

  start(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastActivityAt >= PROGRESS_HEARTBEAT_MS) {
        this.enqueue(buildHeartbeatMessage(this.context));
        this.lastActivityAt = now;
      }
    }, 5_000);
  }

  onEvent(event: CodexEvent): void {
    this.lastActivityAt = Date.now();

    if (event.type === "turn.completed") {
      this.sawTurnCompleted = true;
      this.bufferedAgentMessage = undefined;
      return;
    }

    const progress = describeProgressEvent(event, this.context);
    if (!progress) {
      return;
    }

    if (progress.kind === "agent_message") {
      this.flushBufferedAgent();
      this.bufferedAgentMessage = progress.message;
      return;
    }

    this.flushBufferedAgent();
    this.enqueue(progress.message);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (!this.sawTurnCompleted) {
      this.flushBufferedAgent();
    }

    await this.pending;
  }

  private flushBufferedAgent(): void {
    if (!this.bufferedAgentMessage) {
      return;
    }

    const message = this.bufferedAgentMessage;
    this.bufferedAgentMessage = undefined;
    this.enqueue(message);
  }

  private enqueue(message: string | undefined): void {
    if (!message || this.sentCount >= MAX_PROGRESS_MESSAGES_PER_RUN) {
      return;
    }

    const now = Date.now();
    if (
      message === this.lastMessage &&
      now - this.lastPublishedAt < PROGRESS_DUPLICATE_WINDOW_MS
    ) {
      return;
    }

    this.lastMessage = message;
    this.lastPublishedAt = now;
    this.sentCount += 1;
    this.pending = this.pending.then(async () => {
      try {
        await this.publisher.publishProgress(this.turn, message);
      } catch {
        // Progress updates should not abort the turn.
      }
    });
  }
}

type ProgressMessage =
  | {
      kind: "agent_message";
      message: string;
    }
  | {
      kind: "status";
      message: string;
    };

function describeProgressEvent(
  event: CodexEvent,
  context: CodexProgressContext
): ProgressMessage | undefined {
  if (event.type === "item.completed") {
    return buildItemCompletedMessage(event.item, context);
  }

  return undefined;
}

function buildHeartbeatMessage(context: CodexProgressContext): string {
  if (context.actor === "worker") {
    return `Codex is still working in \`${context.repositoryId ?? "the bound repository"}\`.`;
  }

  return "Codex is still working on your request.";
}

function buildItemCompletedMessage(
  item: unknown,
  context: CodexProgressContext
): ProgressMessage | undefined {
  if (!isRecord(item)) {
    return undefined;
  }

  if (item.type === "agent_message" && typeof item.text === "string") {
    return toProgressMessage(normalizeProgressText(item.text), "agent_message");
  }

  if (item.type === "file_change") {
    return toProgressMessage(formatFileChangeMessage(item, context), "status");
  }

  if (
    item.type === "command_execution" &&
    typeof item.exit_code === "number" &&
    item.exit_code !== 0
  ) {
    return toProgressMessage(
      `${actorLabel(context)} saw a command exit with code ${item.exit_code} and is continuing.`,
      "status"
    );
  }

  return undefined;
}

function actorLabel(context: CodexProgressContext): string {
  if (context.actor === "worker") {
    return `Codex in \`${context.repositoryId ?? "the bound repository"}\``;
  }

  return "Codex";
}

function formatFileChangeMessage(
  item: Record<string, unknown>,
  context: CodexProgressContext
): string | undefined {
  const changes = item.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return undefined;
  }

  const summarized = changes
    .map((change) => summarizeFileChange(change))
    .filter((value): value is string => Boolean(value));

  if (summarized.length === 0) {
    return undefined;
  }

  return `${actorLabel(context)} ${summarized.join(", ")}.`;
}

function summarizeFileChange(change: unknown): string | undefined {
  if (!isRecord(change) || typeof change.path !== "string" || typeof change.kind !== "string") {
    return undefined;
  }

  const fileLabel = `\`${path.basename(change.path)}\``;

  switch (change.kind) {
    case "create":
      return `created ${fileLabel}`;
    case "update":
      return `updated ${fileLabel}`;
    case "delete":
      return `deleted ${fileLabel}`;
    default:
      return `${change.kind} ${fileLabel}`;
  }
}

function normalizeProgressText(text: string): string | undefined {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toProgressMessage(
  message: string | undefined,
  kind: ProgressMessage["kind"]
): ProgressMessage | undefined {
  if (!message) {
    return undefined;
  }

  return {
    kind,
    message
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
