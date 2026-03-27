import { promises as fs } from "node:fs";

import {
  captureTrackedDocumentFiles,
  diffTrackedDocumentFiles,
  listAttachmentAddDirs,
} from "./attachments.js";
import {
  localize,
  resolveConversationLanguage
} from "./conversation-language.js";
import type { BridgeConfig, RepositoryTarget } from "./config.js";
import {
  buildCodexNetworkAccessFailureMessage,
  hasCodexNetworkAccess
} from "./codex-network-access.js";
import type {
  CodexEvent,
  ConversationBinding,
  ConversationLanguage,
  InboundTurn,
  OutboundMessage,
  RepositoryBinding
} from "./domain.js";
import { conversationKeyToId, toConversationKey } from "./domain.js";
import { CodexTurnInterruptedError, type CodexRunner } from "./codex-runner.js";
import {
  buildHandlerUserPrompt,
  parseHandlerDecision,
  type HandlerDecision
} from "./handler-protocol.js";
import { CodexRunProgressReporter } from "./service-progress.js";
import {
  bindRepository,
  buildEffectiveTurn,
  buildHandlerSessionConfig,
  buildResetMessage,
  buildWorkerPrompt,
  buildWorkerReply,
  clipMessage,
  createConversationBinding,
  handlerSessionConfigsEqual,
  listWorkerAddDirs,
  mergeAddDirs,
  mergeBindingAttachments,
  refreshRepositoryBinding,
  resetBinding,
  shouldReuseHandlerSession,
  touchBinding
} from "./service-state.js";
import type { SerialTurnQueue } from "./serial-turn-queue.js";
import type { SessionStore } from "./session-store.js";
import type { TurnPublisher } from "./turn-publisher.js";
import { sanitizeUserFacingText } from "./user-facing-text.js";

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

type ActiveTurnActor = "handler" | "worker";

interface ActiveTurnState {
  actor: ActiveTurnActor;
  repositoryId?: string;
  controller: AbortController;
}

export interface InterruptConversationResult {
  status: "idle" | "requested" | "pending";
  actor?: ActiveTurnActor;
  repositoryId?: string;
}

class InterruptedConversationTurnError extends Error {
  constructor(
    message: string,
    readonly binding: ConversationBinding
  ) {
    super(message);
    this.name = "InterruptedConversationTurnError";
  }
}

export class CodexBridgeService {
  private readonly activeTurns = new Map<string, ActiveTurnState>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly sessionStore: SessionStore,
    private readonly queue: SerialTurnQueue,
    private readonly runner: CodexRunner
  ) {}

  async handleTurn(turn: InboundTurn, publisher: TurnPublisher): Promise<void> {
    const conversationKey = toConversationKey(turn);
    const conversationId = conversationKeyToId(conversationKey);
    const existingBinding = await this.sessionStore.get(conversationKey);
    const initialLanguage = resolveConversationLanguage({
      binding: existingBinding,
      text: turn.text
    });

    if (this.queue.isBusy(conversationId)) {
      await publisher.publishQueued(turn, initialLanguage);
    }

    await this.queue.run(conversationId, async () => {
      let bindingForError = existingBinding ?? createConversationBinding(turn);
      try {
        const storedBinding =
          (await this.sessionStore.get(conversationKey)) ?? createConversationBinding(turn);
        let binding = this.ensureConversationLanguage(storedBinding, turn);
        binding = mergeBindingAttachments(binding, turn.attachments);
        binding = this.refreshBindingForTurn(turn, binding);
        bindingForError = binding;
        const effectiveTurn = buildEffectiveTurn(turn, binding);
        const language = binding.language ?? initialLanguage;

        if (binding !== storedBinding) {
          await this.sessionStore.upsert(binding);
        }

        if (binding.activeRepository) {
          const outcome = await this.completeWorkerTurn(
            effectiveTurn,
            binding,
            effectiveTurn.text,
            publisher
          );
          await this.sessionStore.upsert(outcome.binding);
          await publisher.publishCompleted(effectiveTurn, outcome.finalMessage, language);
          return;
        }

        let finalMessage: OutboundMessage | undefined;

        for (let step = 0; step < this.config.maxHandlerStepsPerTurn; step += 1) {
          const handlerRun = await this.runHandlerTurn(effectiveTurn, binding, publisher);
          binding = handlerRun.binding;
          await this.sessionStore.upsert(binding);

          const outcome = await this.applyHandlerDecision(
            effectiveTurn,
            binding,
            handlerRun.decision,
            publisher
          );
          binding = outcome.binding;
          await this.sessionStore.upsert(binding);

          if (outcome.finalMessage) {
            finalMessage = outcome.finalMessage;
            break;
          }
        }

        if (!finalMessage) {
          throw new Error(
            localize(language, {
              en: "Handler exceeded the maximum number of orchestration steps for one turn.",
              zh: "Handler 在单次 turn 中超过了允许的最大编排步数。"
            })
          );
        }

        await publisher.publishCompleted(effectiveTurn, finalMessage, language);
      } catch (error) {
        const language = resolveConversationLanguage({
          binding: bindingForError,
          text: turn.text
        });
        if (error instanceof InterruptedConversationTurnError) {
          await this.sessionStore.upsert(error.binding);
          await publisher.publishInterrupted(turn, sanitizeUserFacingText(error.message), language);
          return;
        }

        const errorMessage =
          error instanceof Error
            ? error.message
            : localize(language, {
                en: "The bridge hit an unknown failure.",
                zh: "bridge 遇到了未知故障。"
              });
        await publisher.publishFailed(turn, sanitizeUserFacingText(errorMessage), language);
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
      const existing =
        this.ensureConversationLanguage(
          (await this.sessionStore.get(conversationKey)) ?? createConversationBinding(turn),
          turn
        );
      const refreshed = this.refreshHandlerSessionBinding(existing);
      const repository = this.resolveRepository(turn, repositoryId);
      const binding = bindRepository(refreshed, repository, turn.userId);

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

  async interruptConversation(turn: InboundTurn): Promise<InterruptConversationResult> {
    const conversationId = conversationKeyToId(toConversationKey(turn));
    const activeTurn = this.activeTurns.get(conversationId);

    if (!activeTurn) {
      return {
        status: "idle"
      };
    }

    if (activeTurn.controller.signal.aborted) {
      return {
        status: "pending",
        actor: activeTurn.actor,
        repositoryId: activeTurn.repositoryId
      };
    }

    activeTurn.controller.abort();
    return {
      status: "requested",
      actor: activeTurn.actor,
      repositoryId: activeTurn.repositoryId
    };
  }

  private async runHandlerTurn(
    turn: InboundTurn,
    binding: ConversationBinding,
    publisher: TurnPublisher
  ): Promise<HandlerRunResult> {
    const handlerConfig = buildHandlerSessionConfig(this.config);
    const prompt = buildHandlerUserPrompt({
      turn,
      state: binding,
      availableRepositories: this.listAccessibleRepositories(turn),
      requireExplicitRepositorySelection: this.config.requireExplicitRepositorySelection,
      conversationLanguage: binding.language ?? resolveConversationLanguage({ text: turn.text })
    });

    const progress = new CodexRunProgressReporter(turn, publisher, {
      actor: "handler",
      language: binding.language ?? resolveConversationLanguage({ text: turn.text })
    }, {
      mode: this.config.progressUpdates
    });

    return this.runWithActiveTurn(turn, { actor: "handler" }, async (signal) => {
      let result;
      try {
        progress.start();
        result = await this.runner.runTurn({
          prompt,
          repositoryPath: handlerConfig.workspacePath,
          sandboxMode: handlerConfig.sandboxMode,
          approvalPolicy: handlerConfig.approvalPolicy,
          sessionId: binding.handlerSessionId,
          model: handlerConfig.model,
          addDirs: listAttachmentAddDirs(turn.attachments),
          onEvent: (event) => {
            progress.onEvent(event);
          },
          signal
        });
      } catch (error) {
        if (error instanceof CodexTurnInterruptedError) {
          throw new InterruptedConversationTurnError(
            error.message,
            this.buildInterruptedHandlerBinding(binding, error.sessionId)
          );
        }

        throw error;
      } finally {
        await progress.stop();
      }

      return {
        binding: {
          ...binding,
          handlerSessionId: result.sessionId ?? binding.handlerSessionId,
          handlerConfig,
          updatedAt: new Date().toISOString()
        },
        decision: parseHandlerDecision(result.responseText)
      };
    });
  }

  private async applyHandlerDecision(
    turn: InboundTurn,
    binding: ConversationBinding,
    decision: HandlerDecision,
    publisher: TurnPublisher
  ): Promise<{ binding: ConversationBinding; finalMessage?: OutboundMessage }> {
    const language = binding.language ?? resolveConversationLanguage({ text: turn.text });
    let nextBinding = binding;
    let lastAction: HandlerDecision["actions"][number] | undefined;

    for (const action of decision.actions) {
      lastAction = action;

      switch (action.action) {
        case "bind_repo": {
          const repository = this.resolveRepository(turn, action.repositoryId);
          nextBinding = bindRepository(nextBinding, repository, turn.userId);
          break;
        }
        case "delegate": {
          if (!nextBinding.activeRepository) {
            return {
              binding: touchBinding(nextBinding),
              finalMessage: clipMessage(
                this.buildMissingRepositoryMessage(turn, language),
                this.config.maxResponseChars,
                undefined,
                language
              )
            };
          }

          return this.completeWorkerTurn(
            turn,
            nextBinding,
            action.workerPrompt,
            publisher,
            decision.message
          );
        }
        case "reset":
          return {
            binding: resetBinding(nextBinding, action.scope),
            finalMessage: clipMessage(
              decision.message ?? buildResetMessage(action.scope, language),
              this.config.maxResponseChars,
              undefined,
              language
            )
          };
        default:
          return {
            binding: nextBinding,
            finalMessage: clipMessage(
              localize(language, {
                en: "Unsupported handler decision.",
                zh: "不支持的 handler 决策。"
              }),
              this.config.maxResponseChars,
              undefined,
              language
            )
          };
      }
    }

    if (!lastAction) {
      return {
        binding: touchBinding(nextBinding),
        finalMessage: clipMessage(
          decision.message ??
            localize(language, {
              en: "Handler returned an empty response.",
              zh: "Handler 返回了空响应。"
            }),
          this.config.maxResponseChars,
          undefined,
          language
        )
      };
    }

    return {
      binding: nextBinding,
      finalMessage: clipMessage(
        decision.message ??
          localize(language, {
            en: `This thread is now bound to repository "${nextBinding.activeRepository?.repositoryId ?? "unknown"}".`,
            zh: `当前线程已绑定到仓库 "${nextBinding.activeRepository?.repositoryId ?? "unknown"}"。`
          }),
        this.config.maxResponseChars,
        undefined,
        language
      )
    };
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

    return this.runWithActiveTurn(
      turn,
      {
        actor: "worker",
        repositoryId: currentBinding.activeRepository?.repositoryId
      },
      async (signal) => {
        await publisher.publishStarted(
          turn,
          currentBinding,
          note,
          currentBinding.language ?? resolveConversationLanguage({ text: turn.text })
        );

        const workerResult = await this.runWorkerTurn(
          turn,
          currentBinding,
          workerPrompt,
          publisher,
          signal
        );

        return {
          binding: workerResult.binding,
          finalMessage: clipMessage(
            buildWorkerReply(
              workerResult.output,
              currentBinding.language ?? resolveConversationLanguage({ text: turn.text })
            ),
            this.config.maxResponseChars,
            workerResult.returnedFiles,
            currentBinding.language ?? resolveConversationLanguage({ text: turn.text })
          )
        };
      }
    );
  }

  private async runWorkerTurn(
    turn: InboundTurn,
    binding: ConversationBinding,
    workerPrompt: string,
    publisher: TurnPublisher,
    signal: AbortSignal
  ): Promise<{ binding: ConversationBinding; output: string; returnedFiles: OutboundMessage["attachments"] }> {
    if (!binding.activeRepository) {
      throw new Error("A worker turn was requested without an active repository binding.");
    }

    const worker = binding.activeRepository;
    const prompt = buildWorkerPrompt(worker, turn, workerPrompt);
    const progress = new CodexRunProgressReporter(turn, publisher, {
      actor: "worker",
      repositoryId: worker.repositoryId,
      language: binding.language ?? resolveConversationLanguage({ text: turn.text })
    }, {
      mode: this.config.progressUpdates
    });
    const documentFilesBefore = await captureTrackedDocumentFiles(turn.attachments);

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
        addDirs: mergeAddDirs(listWorkerAddDirs(worker), listAttachmentAddDirs(turn.attachments)),
        configOverrides: worker.codexConfigOverrides,
        onEvent: (event) => {
          progress.onEvent(event);
        },
        signal
      });
    } catch (error) {
      if (error instanceof CodexTurnInterruptedError) {
        throw new InterruptedConversationTurnError(
          error.message,
          this.buildInterruptedWorkerBinding(binding, error.sessionId)
        );
      }

      if (error instanceof Error) {
        throw new Error(
          buildCodexNetworkAccessFailureMessage(
            worker,
            error.message,
            binding.language ?? resolveConversationLanguage({ text: turn.text })
          )
        );
      }

      throw error;
    } finally {
      await progress.stop();
    }

    const documentFilesAfter = await captureTrackedDocumentFiles(turn.attachments);

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
      output: result.responseText,
      returnedFiles: diffTrackedDocumentFiles(documentFilesBefore, documentFilesAfter)
    };
  }

  private resolveRepository(turn: InboundTurn, repositoryId: string): RepositoryTarget {
    const language = resolveConversationLanguage({ text: turn.text });
    const repository = this.config.repositoryTargets.find((candidate) => candidate.id === repositoryId);

    if (!repository) {
      throw new Error(
        localize(language, {
          en: `Unknown repository target: ${repositoryId}.`,
          zh: `未知的仓库目标：${repositoryId}。`
        })
      );
    }

    if (!this.hasRepositoryAccess(turn, repository)) {
      throw new Error(
        localize(language, {
          en: "This user or channel is not allowed to access the selected repository target.",
          zh: "当前用户或频道无权访问所选仓库目标。"
        })
      );
    }

    return this.applyRuntimeRepositoryPolicy(repository);
  }

  private listAccessibleRepositories(turn: InboundTurn): RepositoryTarget[] {
    return this.config.repositoryTargets
      .filter((candidate) => this.hasRepositoryAccess(turn, candidate))
      .map((candidate) => this.applyRuntimeRepositoryPolicy(candidate));
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

  private buildMissingRepositoryMessage(
    turn: InboundTurn,
    language: ConversationLanguage
  ): string {
    const available = this.listAccessibleRepositories(turn).map((repository) => repository.id);

    if (available.length === 0) {
      return localize(language, {
        en: "No repositories are available to this user in this channel.",
        zh: "当前用户在此频道中没有可用仓库。"
      });
    }

    return localize(language, {
      en: [
        "No repository is bound to this conversation.",
        'Use `/codex bind <repo-id>` or say `work on <repo-id>` to bind one first, or mention the repository explicitly so the handler can bind it.',
        `Available repositories: ${available.join(", ")}.`
      ].join(" "),
      zh: [
        "当前会话尚未绑定仓库。",
        "请先使用 `/codex bind <repo-id>` 或直接说“切换到 <repo-id>”来完成绑定，或者在消息里明确提到仓库，让 handler 帮你绑定。",
        `可用仓库：${available.join(", ")}。`
      ].join(" ")
    });
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
      this.resolveRepositoryForBinding(binding, turn)
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

  private ensureConversationLanguage(
    binding: ConversationBinding,
    turn: InboundTurn
  ): ConversationBinding {
    const language = resolveConversationLanguage({
      binding,
      text: turn.text
    });

    if (binding.language === language) {
      return binding;
    }

    return {
      ...binding,
      language,
      updatedAt: new Date().toISOString()
    };
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
    const repository = this.config.repositoryTargets.find((candidate) => candidate.id === repositoryId);
    return repository ? this.applyRuntimeRepositoryPolicy(repository) : undefined;
  }

  private applyRuntimeRepositoryPolicy(repository: RepositoryTarget): RepositoryTarget {
    if (!this.config.yoloMode) {
      return repository;
    }

    return {
      ...repository,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never"
    };
  }

  private resolveRepositoryForBinding(
    binding: ConversationBinding,
    turn: InboundTurn
  ): RepositoryTarget {
    if (!binding.activeRepository) {
      throw new Error("A repository refresh was requested without an active repository binding.");
    }

    return this.resolveRepository(
      {
        ...turn,
        platform: binding.key.platform,
        workspaceId: binding.key.workspaceId,
        channelId: binding.key.channelId,
        threadId: binding.key.threadId,
        userId: binding.activeRepository.boundByUserId ?? binding.createdByUserId
      },
      binding.activeRepository.repositoryId
    );
  }

  private async runWithActiveTurn<T>(
    turn: InboundTurn,
    activeTurn: {
      actor: ActiveTurnActor;
      repositoryId?: string;
    },
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const conversationId = conversationKeyToId(toConversationKey(turn));
    const controller = new AbortController();
    const state: ActiveTurnState = {
      ...activeTurn,
      controller
    };

    this.activeTurns.set(conversationId, state);

    try {
      return await task(controller.signal);
    } finally {
      if (this.activeTurns.get(conversationId) === state) {
        this.activeTurns.delete(conversationId);
      }
    }
  }

  private buildInterruptedHandlerBinding(
    binding: ConversationBinding,
    sessionId: string | undefined
  ): ConversationBinding {
    const nextHandlerSessionId = sessionId ?? binding.handlerSessionId;
    const nextHandlerConfig =
      nextHandlerSessionId || binding.handlerConfig
        ? buildHandlerSessionConfig(this.config)
        : binding.handlerConfig;

    return {
      ...binding,
      handlerSessionId: nextHandlerSessionId,
      handlerConfig: nextHandlerConfig,
      updatedAt: new Date().toISOString()
    };
  }

  private buildInterruptedWorkerBinding(
    binding: ConversationBinding,
    sessionId: string | undefined
  ): ConversationBinding {
    if (!binding.activeRepository) {
      return touchBinding(binding);
    }

    const now = new Date().toISOString();
    return {
      ...binding,
      activeRepository: {
        ...binding.activeRepository,
        workerSessionId: sessionId ?? binding.activeRepository.workerSessionId,
        updatedAt: now
      },
      updatedAt: now
    };
  }
}
