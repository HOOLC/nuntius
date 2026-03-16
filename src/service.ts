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
  InboundTurn,
  OutboundMessage,
  RepositoryBinding
} from "./domain.js";
import { conversationKeyToId, toConversationKey } from "./domain.js";
import type { CodexRunner } from "./codex-runner.js";
import {
  buildHandlerUserPrompt,
  buildWorkerResultPrompt,
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
        let binding = (await this.sessionStore.get(conversationKey)) ?? createConversationBinding(turn);
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

  async resetConversation(turn: InboundTurn): Promise<void> {
    await this.resetState(turn, "all");
  }

  async resetState(turn: InboundTurn, scope: "worker" | "binding" | "all"): Promise<void> {
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
      const repository = this.resolveRepository(turn, repositoryId);
      const binding = bindRepository(existing, repository);

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
    publisher: TurnPublisher,
    workerFeedback?: { workerPrompt: string; workerOutput: string }
  ): Promise<HandlerRunResult> {
    const prompt = workerFeedback
      ? buildWorkerResultPrompt({
          turn,
          state: binding,
          workerPrompt: workerFeedback.workerPrompt,
          workerOutput: workerFeedback.workerOutput
        })
      : buildHandlerUserPrompt({
          turn,
          state: binding,
          availableRepositories: this.listAccessibleRepositories(turn),
          requireExplicitRepositorySelection: this.config.requireExplicitRepositorySelection
        });

    const progress = new CodexRunProgressReporter(turn, publisher, {
      actor: "handler",
      announceTurnStart: !workerFeedback
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

        await publisher.publishStarted(turn, nextBinding, decision.message);
        const workerResult = await this.runWorkerTurn(
          turn,
          nextBinding,
          decision.continueWithWorkerPrompt,
          publisher
        );
        nextBinding = workerResult.binding;
        await this.sessionStore.upsert(nextBinding);

        const followUp = await this.runHandlerTurn(turn, nextBinding, publisher, {
          workerPrompt: decision.continueWithWorkerPrompt,
          workerOutput: workerResult.output
        });
        await this.sessionStore.upsert(followUp.binding);

        return this.applyHandlerDecision(turn, followUp.binding, followUp.decision, publisher);
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

        const currentBinding = this.refreshActiveRepositoryBinding(turn, binding);
        await this.sessionStore.upsert(currentBinding);
        await publisher.publishStarted(turn, currentBinding, decision.message);
        const workerResult = await this.runWorkerTurn(
          turn,
          currentBinding,
          decision.workerPrompt,
          publisher
        );
        await this.sessionStore.upsert(workerResult.binding);
        const followUp = await this.runHandlerTurn(turn, workerResult.binding, publisher, {
          workerPrompt: decision.workerPrompt,
          workerOutput: workerResult.output
        });
        await this.sessionStore.upsert(followUp.binding);

        return this.applyHandlerDecision(turn, followUp.binding, followUp.decision, publisher);
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
      "Ask to bind a repository first or mention the repository explicitly so the handler can bind it.",
      `Available repositories: ${available.join(", ")}.`
    ].join(" ");
  }

  private refreshActiveRepositoryBinding(
    turn: InboundTurn,
    binding: ConversationBinding
  ): ConversationBinding {
    if (!binding.activeRepository) {
      return binding;
    }

    return bindRepository(binding, this.resolveRepository(turn, binding.activeRepository.repositoryId));
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
  const previous = binding.activeRepository;
  const now = new Date().toISOString();

  const activeRepository: RepositoryBinding = {
    repositoryId: repository.id,
    repositoryPath: repository.path,
    sandboxMode: repository.sandboxMode,
    model: repository.model,
    approvalPolicy: repository.approvalPolicy,
    codexConfigOverrides: repository.codexConfigOverrides ?? [],
    allowCodexNetworkAccess: Boolean(repository.allowCodexNetworkAccess),
    codexNetworkAccessWorkspacePath: repository.codexNetworkAccessWorkspacePath,
    workerSessionId: shouldReuseWorkerSession(previous, repository) ? previous?.workerSessionId : undefined,
    updatedAt: now
  };

  return {
    ...binding,
    activeRepository,
    updatedAt: now
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

function resetBinding(
  binding: ConversationBinding,
  scope: "worker" | "binding" | "all"
): ConversationBinding {
  const now = new Date().toISOString();

  if (scope === "all") {
    return {
      ...binding,
      handlerSessionId: undefined,
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

function buildResetMessage(scope: "worker" | "binding" | "all"): string {
  switch (scope) {
    case "worker":
      return "Cleared the worker Codex session for this thread.";
    case "binding":
      return "Cleared the repository binding for this thread.";
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
    `- Use this workspace for cloned or downloaded artifacts that do not belong in the primary repository: ${binding.codexNetworkAccessWorkspacePath}`,
    "- Network-dependent commands may still fail if the host Codex runtime or OS policy blocks outbound access.",
    "- If outbound access is unavailable, stop and report the failure clearly instead of claiming you fetched remote data.",
    "",
    "User task:",
    workerPrompt
  ].join("\n");
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
