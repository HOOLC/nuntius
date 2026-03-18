import { promises as fs } from "node:fs";
import path from "node:path";

import {
  captureTrackedDocumentFiles,
  diffTrackedDocumentFiles,
  formatAttachmentsForPrompt,
  listAttachmentAddDirs,
  mergeAttachments
} from "./attachments.js";
import {
  detectConversationLanguage,
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
  HandlerSessionBinding,
  InboundTurn,
  OutboundMessage,
  RepositoryBinding,
  SandboxMode
} from "./domain.js";
import { conversationKeyToId, toConversationKey } from "./domain.js";
import { CodexTurnInterruptedError, type CodexRunner } from "./codex-runner.js";
import {
  buildHandlerUserPrompt,
  parseHandlerDecision,
  type HandlerDecision
} from "./handler-protocol.js";
import type { SerialTurnQueue } from "./serial-turn-queue.js";
import type { SessionStore } from "./session-store.js";

export interface TurnPublisher {
  publishQueued(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
  publishStarted(
    turn: InboundTurn,
    binding: ConversationBinding,
    note: string | undefined,
    language: ConversationLanguage
  ): Promise<void>;
  publishProgress(turn: InboundTurn, message: string, language: ConversationLanguage): Promise<void>;
  publishCompleted(turn: InboundTurn, message: OutboundMessage, language: ConversationLanguage): Promise<void>;
  publishInterrupted(turn: InboundTurn, message: string, language: ConversationLanguage): Promise<void>;
  publishFailed(turn: InboundTurn, errorMessage: string, language: ConversationLanguage): Promise<void>;
  refreshWorkingIndicator?(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
  showWorkingIndicator?(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
  hideWorkingIndicator?(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
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

const EFFECTIVE_SESSION_SANDBOX_MODE: SandboxMode = "danger-full-access";
const HANDLER_SESSION_CONFIG_VERSION = 1;

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
          await publisher.publishInterrupted(turn, error.message, language);
          return;
        }

        const errorMessage =
          error instanceof Error
            ? error.message
            : localize(language, {
                en: "The bridge hit an unknown failure.",
                zh: "bridge 遇到了未知故障。"
              });
        await publisher.publishFailed(turn, errorMessage, language);
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
      announceTurnStart: true,
      language: binding.language ?? resolveConversationLanguage({ text: turn.text })
    });

    return this.runWithActiveTurn(turn, { actor: "handler" }, async (signal) => {
      let result;
      try {
        progress.start();
        result = await this.runner.runTurn({
          prompt,
          repositoryPath: handlerConfig.workspacePath,
          sandboxMode: handlerConfig.sandboxMode,
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

    switch (decision.action) {
      case "reply":
        return {
          binding: touchBinding(binding),
          finalMessage: clipMessage(decision.message, this.config.maxResponseChars, undefined, language)
        };
      case "bind_repo": {
        const repository = this.resolveRepository(turn, decision.repositoryId);
        let nextBinding = bindRepository(binding, repository);

        if (!decision.continueWithWorkerPrompt) {
          return {
            binding: nextBinding,
            finalMessage: clipMessage(
              decision.message ??
                localize(language, {
                  en: `This thread is now bound to repository "${repository.id}".`,
                  zh: `当前线程已绑定到仓库 "${repository.id}"。`
                }),
              this.config.maxResponseChars,
              undefined,
              language
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
              this.buildMissingRepositoryMessage(turn, language),
              this.config.maxResponseChars,
              undefined,
              language
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
            decision.message ?? buildResetMessage(decision.scope, language),
            this.config.maxResponseChars,
            undefined,
            language
          )
        };
      default:
        return {
          binding,
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
      announceTurnStart: false,
      language: binding.language ?? resolveConversationLanguage({ text: turn.text })
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
        "Use `/codex bind <repo-id>` to bind one first, or mention the repository explicitly so the handler can bind it.",
        `Available repositories: ${available.join(", ")}.`
      ].join(" "),
      zh: [
        "当前会话尚未绑定仓库。",
        "请先使用 `/codex bind <repo-id>` 进行绑定，或者在消息里明确提到仓库，让 handler 帮你绑定。",
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
    return this.config.repositoryTargets.find((candidate) => candidate.id === repositoryId);
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

function createConversationBinding(turn: InboundTurn): ConversationBinding {
  const now = new Date().toISOString();
  return {
    key: toConversationKey(turn),
    language: detectConversationLanguage(turn.text),
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
  const sandboxMode = getEffectiveSessionSandboxMode(repository.sandboxMode);

  return {
    repositoryId: repository.id,
    repositoryPath: repository.path,
    sandboxMode,
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

  const sandboxMode = getEffectiveSessionSandboxMode(repository.sandboxMode);

  return (
    previous.repositoryPath === repository.path &&
    previous.sandboxMode === sandboxMode &&
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
    sandboxMode: getEffectiveSessionSandboxMode(config.handlerSandboxMode),
    model: config.handlerModel,
    sessionConfigVersion: HANDLER_SESSION_CONFIG_VERSION
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
    left?.model === right?.model &&
    left?.sessionConfigVersion === right?.sessionConfigVersion
  );
}

function getEffectiveSessionSandboxMode(_: SandboxMode): SandboxMode {
  return EFFECTIVE_SESSION_SANDBOX_MODE;
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

function buildResetMessage(
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

function touchBinding(binding: ConversationBinding): ConversationBinding {
  return {
    ...binding,
    updatedAt: new Date().toISOString()
  };
}

function buildWorkerReply(output: string, language: ConversationLanguage): string {
  return (
    output.trim() ||
    localize(language, {
      en: "Codex completed the requested work.",
      zh: "Codex 已完成所请求的工作。"
    })
  );
}

function clipMessage(
  text: string,
  maxChars: number,
  attachments: OutboundMessage["attachments"] | undefined,
  language: ConversationLanguage
): OutboundMessage {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
      attachments
    };
  }

  return {
    text: `${text.slice(0, maxChars - 16)}\n\n${localize(language, {
      en: "[truncated...]",
      zh: "[内容已截断...]"
    })}`,
    truncated: true,
    attachments
  };
}

function buildWorkerPrompt(
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

function listWorkerAddDirs(binding: RepositoryBinding): string[] | undefined {
  if (!hasCodexNetworkAccess(binding)) {
    return undefined;
  }

  return [binding.codexNetworkAccessWorkspacePath];
}

function mergeAddDirs(...groups: Array<string[] | undefined>): string[] | undefined {
  const merged = [...new Set(groups.flatMap((group) => group ?? []))];
  return merged.length > 0 ? merged : undefined;
}

function arraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function attachmentsEqual(left: ConversationBinding["attachments"], right: ConversationBinding["attachments"]): boolean {
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

function mergeBindingAttachments(
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

function buildEffectiveTurn(turn: InboundTurn, binding: ConversationBinding): InboundTurn {
  const attachments = mergeAttachments(binding.attachments, turn.attachments);
  if (attachmentsEqual(turn.attachments, attachments)) {
    return turn;
  }

  return {
    ...turn,
    attachments
  };
}

const PROGRESS_HEARTBEAT_MS = 20_000;
const PROGRESS_DUPLICATE_WINDOW_MS = 4_000;
const MAX_PROGRESS_MESSAGES_PER_RUN = 14;

type CodexProgressActor = ActiveTurnActor;

interface CodexProgressContext {
  actor: CodexProgressActor;
  repositoryId?: string;
  announceTurnStart: boolean;
  language: ConversationLanguage;
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
  private workingIndicatorVisible = false;

  constructor(
    private readonly turn: InboundTurn,
    private readonly publisher: TurnPublisher,
    private readonly context: CodexProgressContext
  ) {}

  start(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastActivityAt >= PROGRESS_HEARTBEAT_MS) {
        this.publishHeartbeat();
        this.lastActivityAt = now;
      }
    }, 5_000);
  }

  onEvent(event: CodexEvent): void {
    this.lastActivityAt = Date.now();
    this.hideWorkingIndicator();

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

    this.hideWorkingIndicator();

    if (!this.sawTurnCompleted) {
      this.flushBufferedAgent();
    }

    await this.pending;
  }

  private publishHeartbeat(): void {
    if (typeof this.publisher.refreshWorkingIndicator === "function") {
      this.refreshWorkingIndicator();
      return;
    }

    if (typeof this.publisher.showWorkingIndicator === "function") {
      this.showWorkingIndicator();
      return;
    }

    this.enqueue(buildHeartbeatMessage(this.context));
  }

  private refreshWorkingIndicator(): void {
    this.workingIndicatorVisible = true;
    this.pending = this.pending.then(async () => {
      try {
        await this.publisher.refreshWorkingIndicator?.(this.turn, this.context.language);
      } catch {
        // Typing indicator failures should not abort the turn.
      }
    });
  }

  private showWorkingIndicator(): void {
    if (this.workingIndicatorVisible) {
      return;
    }

    this.workingIndicatorVisible = true;
    this.pending = this.pending.then(async () => {
      try {
        await this.publisher.showWorkingIndicator?.(this.turn, this.context.language);
      } catch {
        // Typing indicator failures should not abort the turn.
      }
    });
  }

  private hideWorkingIndicator(): void {
    if (!this.workingIndicatorVisible) {
      return;
    }

    this.workingIndicatorVisible = false;
    this.pending = this.pending.then(async () => {
      try {
        await this.publisher.hideWorkingIndicator?.(this.turn, this.context.language);
      } catch {
        // Typing indicator failures should not abort the turn.
      }
    });
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
        await this.publisher.publishProgress(this.turn, message, this.context.language);
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
    return localize(context.language, {
      en: `Codex is still working in \`${context.repositoryId ?? "the bound repository"}\`.`,
      zh: `Codex 仍在仓库 \`${context.repositoryId ?? "当前绑定的仓库"}\` 中继续处理。`
    });
  }

  return localize(context.language, {
    en: "Codex is still working on your request.",
    zh: "Codex 仍在处理你的请求。"
  });
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
      localize(context.language, {
        en: `${actorLabel(context)} saw a command exit with code ${item.exit_code} and is continuing.`,
        zh: `${actorLabel(context)} 发现某个命令以退出码 ${item.exit_code} 结束，正在继续处理。`
      }),
      "status"
    );
  }

  return undefined;
}

function actorLabel(context: CodexProgressContext): string {
  if (context.actor === "worker") {
    return localize(context.language, {
      en: `Codex in \`${context.repositoryId ?? "the bound repository"}\``,
      zh: `仓库 \`${context.repositoryId ?? "当前绑定的仓库"}\` 中的 Codex`
    });
  }

  return localize(context.language, {
    en: "Codex",
    zh: "Codex"
  });
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
    .map((change) => summarizeFileChange(change, context.language))
    .filter((value): value is string => Boolean(value));

  if (summarized.length === 0) {
    return undefined;
  }

  return `${actorLabel(context)} ${summarized.join(", ")}.`;
}

function summarizeFileChange(
  change: unknown,
  language: ConversationLanguage
): string | undefined {
  if (!isRecord(change) || typeof change.path !== "string" || typeof change.kind !== "string") {
    return undefined;
  }

  const fileLabel = `\`${path.basename(change.path)}\``;

  switch (change.kind) {
    case "create":
      return localize(language, {
        en: `created ${fileLabel}`,
        zh: `创建了 ${fileLabel}`
      });
    case "update":
      return localize(language, {
        en: `updated ${fileLabel}`,
        zh: `更新了 ${fileLabel}`
      });
    case "delete":
      return localize(language, {
        en: `deleted ${fileLabel}`,
        zh: `删除了 ${fileLabel}`
      });
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
