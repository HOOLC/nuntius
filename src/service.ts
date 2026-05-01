import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
import {
  CodexTurnInterruptedError,
  type CodexDynamicToolCallResponse,
  type CodexRunner
} from "./codex-runner.js";
import {
  buildHandlerDynamicTools,
  buildHandlerUserPrompt,
  parseHandlerToolCall,
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
  clearPendingWorkerWakeRequest,
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
import {
  appendScheduledTaskStatusLog,
  buildScheduledTaskExecutionPrompt,
  buildScheduledTaskPaths,
  buildScheduledTaskPlanningPrompt,
  createScheduledTaskId,
  parseScheduledTaskSchedule,
  readScheduledTaskControlState,
  scheduledTaskShouldStop,
  updateScheduledTaskControlState,
  writeScheduledTaskScaffold
} from "./scheduled-task-documents.js";
import {
  deriveScheduledTaskStorePath,
  FileScheduledTaskStore,
  type ScheduledTaskRecord
} from "./scheduled-task-store.js";
import type { SessionStore } from "./session-store.js";
import type { TurnPublisher } from "./turn-publisher.js";
import { sanitizeUserFacingText } from "./user-facing-text.js";
import {
  WAKE_AFTER_TOOL_USAGE,
  buildWorkerDynamicTools,
  formatWakeDuration,
  parseWorkerDecision,
  parseWorkerToolCall,
  type WorkerControlAction
} from "./worker-protocol.js";

const SCHEDULED_TASK_EXECUTION_LEASE_MS = 10 * 60_000;
const SCHEDULED_TASK_LEASE_RENEW_MS = 60_000;

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
  latestToolSummary?: string;
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
  private readonly queuedWakeRuns = new Set<string>();
  private readonly scheduledTaskStore: FileScheduledTaskStore;

  constructor(
    private readonly config: BridgeConfig,
    private readonly sessionStore: SessionStore,
    private readonly queue: SerialTurnQueue,
    private readonly runner: CodexRunner
  ) {
    this.scheduledTaskStore = new FileScheduledTaskStore(
      deriveScheduledTaskStorePath(config.sessionStorePath)
    );
  }

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

        if (this.shouldWaitForAttachmentInstructions(turn)) {
          await publisher.publishCompleted(turn, {
            text: this.buildAttachmentInstructionMessage(turn.attachments.length, language)
          }, language);
          return;
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
            finalMessage = this.decorateLatestFinalMessage(
              outcome.finalMessage,
              handlerRun.latestToolSummary,
              language
            );
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
      const binding = clearPendingWorkerWakeRequest(
        bindRepository(refreshed, repository, turn.userId)
      );

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

  async listScheduledTasks(turn: InboundTurn): Promise<ScheduledTaskRecord[]> {
    const accessibleRepositories = new Set(
      this.listAccessibleRepositories(turn).map((repository) => repository.id)
    );

    return (await this.scheduledTaskStore.list()).filter((task) =>
      accessibleRepositories.has(task.repositoryId)
    );
  }

  async runDueScheduledTasks(input: {
    ownerId: string;
    maxTasks?: number;
  }): Promise<number> {
    const maxTasks = input.maxTasks ?? Number.POSITIVE_INFINITY;
    let completedTasks = 0;

    while (completedTasks < maxTasks) {
      const now = new Date().toISOString();
      const executionId = createScheduledTaskId("execution");
      const task = await this.scheduledTaskStore.claimDueTask({
        ownerId: input.ownerId,
        executionId,
        now,
        leaseMs: SCHEDULED_TASK_EXECUTION_LEASE_MS
      });

      if (!task) {
        break;
      }

      try {
        await this.executeScheduledTask(task, {
          ownerId: input.ownerId,
          executionId
        });
      } catch (error) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`Scheduled task "${task.id}" failed: ${message}`);
      }

      completedTasks += 1;
    }

    return completedTasks;
  }

  async runDueWakeRequests(input: {
    maxConversations?: number;
  } = {}): Promise<number> {
    const maxConversations = input.maxConversations ?? Number.POSITIVE_INFINITY;
    const now = Date.now();
    const bindings = (await this.sessionStore.list())
      .filter((binding) => {
        const dueAt = binding.activeRepository?.pendingWakeRequest?.dueAt;
        return typeof dueAt === "string" && Date.parse(dueAt) <= now;
      })
      .sort((left, right) => {
        const leftDueAt = Date.parse(left.activeRepository?.pendingWakeRequest?.dueAt ?? "");
        const rightDueAt = Date.parse(right.activeRepository?.pendingWakeRequest?.dueAt ?? "");
        return leftDueAt - rightDueAt;
      });

    let completedConversations = 0;

    for (const binding of bindings) {
      if (completedConversations >= maxConversations) {
        break;
      }

      const wakeRequest = binding.activeRepository?.pendingWakeRequest;
      const conversationId = conversationKeyToId(binding.key);
      if (!wakeRequest || this.queuedWakeRuns.has(conversationId)) {
        continue;
      }

      this.queuedWakeRuns.add(conversationId);
      try {
        const completed = await this.queue.run(conversationId, async () =>
          this.runQueuedWakeRequest(binding.key, wakeRequest.id)
        );
        if (completed) {
          completedConversations += 1;
        }
      } finally {
        this.queuedWakeRuns.delete(conversationId);
      }
    }

    return completedConversations;
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
      const nativeActions: HandlerDecision["actions"] = [];
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
          dynamicTools: buildHandlerDynamicTools(),
          onDynamicToolCall: (call) => {
            try {
              const action = parseHandlerToolCall(call);
              nativeActions.push(action);
              return buildDynamicToolTextResponse(describeHandlerToolAction(action), true);
            } catch (error) {
              return buildDynamicToolTextResponse(formatToolError(error), false);
            }
          },
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
        decision: mergeHandlerDecision(result.responseText, nativeActions),
        latestToolSummary: progress.getLatestToolSummary()
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
          nextBinding = clearPendingWorkerWakeRequest(
            bindRepository(nextBinding, repository, turn.userId)
          );
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
        case "schedule_task": {
          const repository = this.resolveRepository(turn, action.repositoryId);
          const parsedSchedule = parseScheduledTaskSchedule(action.schedule);
          if (!parsedSchedule) {
            return {
              binding: touchBinding(nextBinding),
              finalMessage: clipMessage(
                localize(language, {
                  en: `Unsupported scheduled-task cadence: ${action.schedule}.`,
                  zh: `不支持的定时任务频率：${action.schedule}。`
                }),
                this.config.maxResponseChars,
                undefined,
                language
              )
            };
          }

          return this.createScheduledTask(
            turn,
            nextBinding,
            repository,
            {
              rawRequest: turn.text,
              taskSummary: action.taskPrompt,
              scheduleDescription: parsedSchedule.scheduleDescription,
              intervalMs: parsedSchedule.intervalMs
            },
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
    const currentBinding = clearPendingWorkerWakeRequest(
      this.refreshActiveRepositoryBinding(turn, binding)
    );
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

        const language = currentBinding.language ?? resolveConversationLanguage({ text: turn.text });
        const wakeRequest = workerResult.binding.activeRepository?.pendingWakeRequest;
        const visibleReply =
          workerResult.output.trim() ||
          (wakeRequest
            ? localize(language, {
                en: `I'll wake this worker session up again in ${formatWakeDuration(
                  wakeRequest.durationMs,
                  language
                )}.`,
                zh: `我会在 ${formatWakeDuration(
                  wakeRequest.durationMs,
                  language
                )}后再次唤醒这个 worker session。`
              })
            : buildWorkerReply(workerResult.output, language));

        return {
          binding: workerResult.binding,
          finalMessage: clipMessage(
            this.appendLatestToolSummary(visibleReply, workerResult.latestToolSummary),
            this.config.maxResponseChars,
            workerResult.returnedFiles,
            language
          )
        };
      }
    );
  }

  private async createScheduledTask(
    turn: InboundTurn,
    binding: ConversationBinding,
    repository: RepositoryTarget,
    request: {
      rawRequest: string;
      taskSummary: string;
      scheduleDescription: string;
      intervalMs: number;
    },
    publisher: TurnPublisher,
    note?: string
  ): Promise<{ binding: ConversationBinding; finalMessage: OutboundMessage }> {
    const executionBinding = bindRepository(
      this.refreshHandlerSessionBinding(binding),
      repository,
      turn.userId
    );
    const worker = executionBinding.activeRepository;
    const language = executionBinding.language ?? resolveConversationLanguage({ text: turn.text });

    if (!worker) {
      throw new Error("Scheduled task creation requires a repository binding snapshot.");
    }

    if (worker.sandboxMode === "read-only") {
      throw new Error(
        localize(language, {
          en: "Scheduled tasks require a writable repository sandbox because the agent must maintain task documents.",
          zh: "定时任务需要可写的仓库沙箱，因为 agent 需要持续维护任务文档。"
        })
      );
    }

    const createdAt = new Date();
    const taskId = createScheduledTaskId(request.taskSummary, createdAt);
    const taskPaths = buildScheduledTaskPaths(worker.repositoryPath, taskId);

    await writeScheduledTaskScaffold({
      taskId,
      repositoryId: worker.repositoryId,
      repositoryPath: worker.repositoryPath,
      taskDir: taskPaths.taskDir,
      taskDocumentPath: taskPaths.taskDocumentPath,
      statusDocumentPath: taskPaths.statusDocumentPath,
      rawRequest: request.rawRequest,
      taskSummary: request.taskSummary,
      scheduleDescription: request.scheduleDescription,
      createdAt: createdAt.toISOString(),
      createdByUserId: turn.userId,
      sourceConversationId: conversationKeyToId(binding.key)
    });

    let taskCreated = false;

    try {
      return await this.runWithActiveTurn(
        turn,
        {
          actor: "worker",
          repositoryId: worker.repositoryId
        },
        async (signal) => {
          await publisher.publishStarted(
            turn,
            executionBinding,
            note ?? localize(language, {
              en: "Planning scheduled task.",
              zh: "正在规划定时任务。"
            }),
            language
          );

          const progress = new CodexRunProgressReporter(turn, publisher, {
            actor: "worker",
            repositoryId: worker.repositoryId,
            language
          }, {
            mode: this.config.progressUpdates
          });

          if (hasCodexNetworkAccess(worker)) {
            await fs.mkdir(worker.codexNetworkAccessWorkspacePath, { recursive: true });
          }

          let result;
          try {
            progress.start();
            result = await this.runner.runTurn({
              prompt: this.buildRepositoryTaskPrompt(
                worker,
                buildScheduledTaskPlanningPrompt({
                  repositoryId: worker.repositoryId,
                  taskId,
                  taskDir: taskPaths.taskDir,
                  taskDocumentPath: taskPaths.taskDocumentPath,
                  statusDocumentPath: taskPaths.statusDocumentPath,
                  rawRequest: request.rawRequest,
                  scheduleDescription: request.scheduleDescription
                })
              ),
              repositoryPath: worker.repositoryPath,
              sandboxMode: worker.sandboxMode,
              model: worker.model,
              approvalPolicy: worker.approvalPolicy,
              searchEnabled: hasCodexNetworkAccess(worker),
              networkAccessEnabled: hasCodexNetworkAccess(worker),
              addDirs: listWorkerAddDirs(worker),
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
                touchBinding(binding)
              );
            }

            if (error instanceof Error) {
              throw new Error(
                buildCodexNetworkAccessFailureMessage(worker, error.message, language)
              );
            }

            throw error;
          } finally {
            await progress.stop();
          }

          const completedAt = new Date().toISOString();
          await updateScheduledTaskControlState(taskPaths.statusDocumentPath, {
            task_status: "active",
            scheduler_action: "continue",
            last_updated: completedAt
          });
          await appendScheduledTaskStatusLog(
            taskPaths.statusDocumentPath,
            `Planning completed at ${completedAt}`,
            [
              `Planner summary: ${this.summarizeScheduledTaskResponse(result.responseText)}`,
              "Task documents are ready for scheduled execution."
            ]
          );

          const taskRecord: ScheduledTaskRecord = {
            id: taskId,
            repositoryId: worker.repositoryId,
            repositoryPath: worker.repositoryPath,
            sandboxMode: worker.sandboxMode,
            model: worker.model,
            approvalPolicy: worker.approvalPolicy,
            codexConfigOverrides: worker.codexConfigOverrides,
            allowCodexNetworkAccess: worker.allowCodexNetworkAccess,
            codexNetworkAccessWorkspacePath: worker.codexNetworkAccessWorkspacePath,
            taskDir: taskPaths.taskDir,
            taskDocumentPath: taskPaths.taskDocumentPath,
            statusDocumentPath: taskPaths.statusDocumentPath,
            rawRequest: request.rawRequest,
            taskSummary: request.taskSummary,
            scheduleDescription: request.scheduleDescription,
            intervalMs: request.intervalMs,
            state: "active",
            createdByUserId: turn.userId,
            createdAt: createdAt.toISOString(),
            updatedAt: completedAt,
            nextRunAt: new Date(createdAt.getTime() + request.intervalMs).toISOString(),
            runCount: 0
          };

          await this.scheduledTaskStore.create(taskRecord);
          taskCreated = true;

          return {
            binding: touchBinding(binding),
            finalMessage: clipMessage(
              this.appendLatestToolSummary(
                this.buildScheduledTaskCreatedMessage(
                  taskRecord,
                  this.summarizeScheduledTaskResponse(result.responseText),
                  language
                ),
                progress.getLatestToolSummary()
              ),
              this.config.maxResponseChars,
              undefined,
              language
            )
          };
        }
      );
    } catch (error) {
      if (!taskCreated) {
        await fs.rm(taskPaths.taskDir, { recursive: true, force: true });
      }

      throw error;
    }
  }

  private async executeScheduledTask(
    task: ScheduledTaskRecord,
    lease: {
      ownerId: string;
      executionId: string;
    }
  ): Promise<void> {
    const startedAt = task.lastRunStartedAt ?? new Date().toISOString();
    const taskStatusPath = task.statusDocumentPath;

    await updateScheduledTaskControlState(taskStatusPath, {
      task_status: "running",
      scheduler_action: "continue",
      last_execution_id: lease.executionId,
      last_execution_started_at: startedAt,
      last_updated: startedAt
    });
    await appendScheduledTaskStatusLog(
      taskStatusPath,
      `Execution ${lease.executionId} started at ${startedAt}`,
      [
        "Scheduler claimed the task for execution.",
        `Repository: ${task.repositoryId}`
      ]
    );

    if (task.allowCodexNetworkAccess && task.codexNetworkAccessWorkspacePath) {
      await fs.mkdir(task.codexNetworkAccessWorkspacePath, { recursive: true });
    }

    const renewTimer = setInterval(() => {
      void this.scheduledTaskStore.renewLease({
        taskId: task.id,
        ownerId: lease.ownerId,
        executionId: lease.executionId,
        now: new Date().toISOString(),
        leaseMs: SCHEDULED_TASK_EXECUTION_LEASE_MS
      });
    }, SCHEDULED_TASK_LEASE_RENEW_MS);
    renewTimer.unref?.();

    try {
      const result = await this.runner.runTurn({
        prompt: this.buildRepositoryTaskPrompt(
          task,
          buildScheduledTaskExecutionPrompt({
            repositoryId: task.repositoryId,
            taskId: task.id,
            taskDocumentPath: task.taskDocumentPath,
            statusDocumentPath: task.statusDocumentPath,
            executionId: lease.executionId
          })
        ),
        repositoryPath: task.repositoryPath,
        sandboxMode: task.sandboxMode,
        model: task.model,
        approvalPolicy: task.approvalPolicy,
        searchEnabled: Boolean(task.allowCodexNetworkAccess),
        networkAccessEnabled: Boolean(task.allowCodexNetworkAccess),
        addDirs:
          task.allowCodexNetworkAccess && task.codexNetworkAccessWorkspacePath
            ? [task.codexNetworkAccessWorkspacePath]
            : undefined,
        configOverrides: task.codexConfigOverrides
      });

      const finishedAt = new Date().toISOString();
      const controlState = await this.readScheduledTaskControlStateSafe(taskStatusPath);
      const stop = scheduledTaskShouldStop(controlState);
      const nextTaskStatus =
        stop
          ? "completed"
          : controlState.taskStatus === "running"
            ? "active"
            : controlState.taskStatus;

      await updateScheduledTaskControlState(taskStatusPath, {
        task_status: nextTaskStatus,
        scheduler_action: stop ? "stop" : "continue",
        last_execution_id: lease.executionId,
        last_execution_finished_at: finishedAt,
        last_updated: finishedAt
      });
      await appendScheduledTaskStatusLog(
        taskStatusPath,
        `Execution ${lease.executionId} completed at ${finishedAt}`,
        [
          `Scheduler summary: ${this.summarizeScheduledTaskResponse(result.responseText)}`,
          `Next action: ${stop ? "stop" : "continue"}`
        ]
      );
      await this.scheduledTaskStore.completeExecution({
        taskId: task.id,
        ownerId: lease.ownerId,
        executionId: lease.executionId,
        finishedAt,
        stop
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const errorMessage =
        error instanceof Error
          ? buildCodexNetworkAccessFailureMessage(task, error.message)
          : `Unknown scheduled task failure for "${task.id}".`;

      await updateScheduledTaskControlState(taskStatusPath, {
        task_status: "active",
        scheduler_action: "continue",
        last_execution_id: lease.executionId,
        last_execution_finished_at: finishedAt,
        last_updated: finishedAt
      });
      await appendScheduledTaskStatusLog(
        taskStatusPath,
        `Execution ${lease.executionId} failed at ${finishedAt}`,
        [sanitizeUserFacingText(errorMessage)]
      );
      await this.scheduledTaskStore.failExecution({
        taskId: task.id,
        ownerId: lease.ownerId,
        executionId: lease.executionId,
        finishedAt,
        errorMessage
      });
      throw error;
    } finally {
      clearInterval(renewTimer);
    }
  }

  private async runWorkerTurn(
    turn: InboundTurn,
    binding: ConversationBinding,
    workerPrompt: string,
    publisher: TurnPublisher,
    signal: AbortSignal
  ): Promise<{
    binding: ConversationBinding;
    output: string;
    returnedFiles: OutboundMessage["attachments"];
    latestToolSummary?: string;
  }> {
    if (!binding.activeRepository) {
      throw new Error("A worker turn was requested without an active repository binding.");
    }

    const worker = binding.activeRepository;
    const language = binding.language ?? resolveConversationLanguage({ text: turn.text });
    const prompt = buildWorkerPrompt(worker, turn, workerPrompt);
    const progress = new CodexRunProgressReporter(turn, publisher, {
      actor: "worker",
      repositoryId: worker.repositoryId,
      language
    }, {
      mode: this.config.progressUpdates
    });
    const documentFilesBefore = await captureTrackedDocumentFiles(turn.attachments);

    if (hasCodexNetworkAccess(worker)) {
      await fs.mkdir(worker.codexNetworkAccessWorkspacePath, { recursive: true });
    }

    let result;
    const nativeActions: WorkerControlAction[] = [];
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
        dynamicTools: buildWorkerDynamicTools(),
        onDynamicToolCall: (call) => {
          try {
            const action = parseWorkerToolCall(call);
            nativeActions.push(action);
            return buildDynamicToolTextResponse(describeWorkerToolAction(action, language), true);
          } catch (error) {
            return buildDynamicToolTextResponse(formatToolError(error), false);
          }
        },
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
            language
          )
        );
      }

      throw error;
    } finally {
      await progress.stop();
    }

    const documentFilesAfter = await captureTrackedDocumentFiles(turn.attachments);
    const workerDecision = mergeWorkerDecision(result.responseText, nativeActions);

    return {
      binding: this.buildWorkerResultBinding(binding, worker, result.sessionId, workerDecision),
      output: workerDecision.message ?? "",
      returnedFiles: diffTrackedDocumentFiles(documentFilesBefore, documentFilesAfter),
      latestToolSummary: progress.getLatestToolSummary()
    };
  }

  private decorateLatestFinalMessage(
    message: OutboundMessage,
    latestToolSummary: string | undefined,
    language: ConversationLanguage
  ): OutboundMessage {
    return clipMessage(
      this.appendLatestToolSummary(message.text, latestToolSummary),
      this.config.maxResponseChars,
      message.attachments,
      language
    );
  }

  private appendLatestToolSummary(
    message: string,
    latestToolSummary: string | undefined
  ): string {
    if (this.config.progressUpdates !== "latest" || !latestToolSummary) {
      return message;
    }

    const normalizedMessage = message.trim();
    const normalizedSummary = latestToolSummary.trim();
    if (!normalizedMessage) {
      return normalizedSummary;
    }

    return `${normalizedMessage}\n\n${normalizedSummary}`;
  }

  private buildRepositoryTaskPrompt(
    worker: Pick<
      RepositoryBinding,
      | "repositoryId"
      | "repositoryPath"
      | "sandboxMode"
      | "allowCodexNetworkAccess"
      | "codexNetworkAccessWorkspacePath"
    >,
    taskPrompt: string
  ): string {
    const lines: string[] = [];

    if (hasCodexNetworkAccess(worker)) {
      lines.push(
        "Worker execution context:",
        `- Primary repository path: ${worker.repositoryPath}`,
        "- nuntius requested web access for this worker session by launching Codex with `--search`.",
        worker.sandboxMode === "workspace-write"
          ? "- nuntius also enabled outbound shell network access for the workspace-write sandbox via `-c sandbox_workspace_write.network_access=true`."
          : "",
        `- Use this workspace for cloned or downloaded artifacts that do not belong in the primary repository: ${worker.codexNetworkAccessWorkspacePath}`,
        "- Network-dependent commands may still fail if the host Codex runtime or OS policy blocks outbound access.",
        "- If outbound access is unavailable, stop and report the failure clearly instead of claiming you fetched remote data.",
        ""
      );
    }

    lines.push(taskPrompt);
    return lines.filter(Boolean).join("\n");
  }

  private buildScheduledTaskCreatedMessage(
    task: ScheduledTaskRecord,
    plannerSummary: string,
    language: ConversationLanguage
  ): string {
    const relativeTaskDir = path.relative(task.repositoryPath, task.taskDir) || ".";
    return [
      localize(language, {
        en: `Created scheduled task "${task.id}" for repository "${task.repositoryId}".`,
        zh: `已为仓库 "${task.repositoryId}" 创建定时任务 "${task.id}"。`
      }),
      localize(language, {
        en: `Schedule: ${task.scheduleDescription}. Next run: ${task.nextRunAt ?? "not scheduled"}.`,
        zh: `执行频率：${task.scheduleDescription}。下次运行：${task.nextRunAt ?? "未安排"}。`
      }),
      localize(language, {
        en: `Task folder: ${relativeTaskDir}`,
        zh: `任务目录：${relativeTaskDir}`
      }),
      localize(language, {
        en: `Planner summary: ${plannerSummary}`,
        zh: `规划摘要：${plannerSummary}`
      })
    ].join("\n");
  }

  private summarizeScheduledTaskResponse(responseText: string): string {
    const sanitized = sanitizeUserFacingText(responseText).replace(/\s+/g, " ").trim();
    if (!sanitized) {
      return "No summary returned.";
    }

    return sanitized.length <= 280 ? sanitized : `${sanitized.slice(0, 277)}...`;
  }

  private async readScheduledTaskControlStateSafe(
    filePath: string
  ): Promise<Awaited<ReturnType<typeof readScheduledTaskControlState>> | {
    frontMatter: Record<string, string>;
    body: string;
    taskStatus: string;
    schedulerAction: "continue";
  }> {
    try {
      return await readScheduledTaskControlState(filePath);
    } catch {
      return {
        frontMatter: {},
        body: "",
        taskStatus: "active",
        schedulerAction: "continue"
      };
    }
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

  private shouldWaitForAttachmentInstructions(turn: InboundTurn): boolean {
    return turn.attachments.length > 0 && turn.text.trim().length === 0;
  }

  private buildAttachmentInstructionMessage(
    attachmentCount: number,
    language: ConversationLanguage
  ): string {
    if (attachmentCount === 1) {
      return localize(language, {
        en: "Saved the attachment from this message. Send another message telling Codex what to do, and the next turn will include it.",
        zh: "已保存这条消息里的附件。请再发一条消息告诉 Codex 要做什么，下一次处理时会自动带上它。"
      });
    }

    return localize(language, {
      en: `Saved the ${attachmentCount} attachments from this message. Send another message telling Codex what to do, and the next turn will include them.`,
      zh: `已保存这条消息里的 ${attachmentCount} 个附件。请再发一条消息告诉 Codex 要做什么，下一次处理时会自动带上它们。`
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
        pendingWakeRequest: undefined,
        workerSessionId: sessionId ?? binding.activeRepository.workerSessionId,
        updatedAt: now
      },
      updatedAt: now
    };
  }

  private async runQueuedWakeRequest(
    conversationKey: ConversationBinding["key"],
    wakeRequestId: string
  ): Promise<boolean> {
    const current = await this.sessionStore.get(conversationKey);
    const wakeRequest = current?.activeRepository?.pendingWakeRequest;
    if (!current || !wakeRequest || wakeRequest.id !== wakeRequestId) {
      return false;
    }

    if (Date.parse(wakeRequest.dueAt) > Date.now()) {
      return false;
    }

    const clearedBinding = clearPendingWorkerWakeRequest(current);
    await this.sessionStore.upsert(clearedBinding);

    try {
      await this.executeWakeRequest(clearedBinding, wakeRequest);
    } catch (error) {
      const conversationId = conversationKeyToId(conversationKey);
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`Worker wake-up for "${conversationId}" failed: ${message}`);
    }

    return true;
  }

  private async executeWakeRequest(
    binding: ConversationBinding,
    wakeRequest: NonNullable<RepositoryBinding["pendingWakeRequest"]>
  ): Promise<void> {
    if (!binding.activeRepository) {
      return;
    }

    const turn = this.buildWakeTurn(binding);
    const language = binding.language ?? resolveConversationLanguage({ text: turn.text });
    const outcome = await this.completeWorkerTurn(
      turn,
      binding,
      this.buildWakePrompt(wakeRequest, language),
      NOOP_TURN_PUBLISHER,
      localize(language, {
        en: `Background wake-up after ${formatWakeDuration(wakeRequest.durationMs, language)}.`,
        zh: `${formatWakeDuration(wakeRequest.durationMs, language)}后的后台唤醒。`
      })
    );
    await this.sessionStore.upsert(outcome.binding);
  }

  private buildWakeTurn(binding: ConversationBinding): InboundTurn {
    return {
      platform: binding.key.platform,
      workspaceId: binding.key.workspaceId,
      channelId: binding.key.channelId,
      threadId: binding.key.threadId,
      userId: binding.activeRepository?.boundByUserId ?? binding.createdByUserId,
      userDisplayName: "nuntius wake scheduler",
      scope: binding.key.threadId ? "thread" : "channel",
      text: "[nuntius internal wake-up]",
      attachments: binding.attachments ?? [],
      repositoryId: binding.activeRepository?.repositoryId,
      receivedAt: new Date().toISOString()
    };
  }

  private buildWakePrompt(
    wakeRequest: NonNullable<RepositoryBinding["pendingWakeRequest"]>,
    language: ConversationLanguage
  ): string {
    return [
      localize(language, {
        en: "System wake-up: the timer you requested for this worker session has elapsed.",
        zh: "系统唤醒：你为这个 worker session 请求的定时器已经到期。"
      }),
      localize(language, {
        en: `Requested delay: ${formatWakeDuration(wakeRequest.durationMs, language)}.`,
        zh: `请求的延迟：${formatWakeDuration(wakeRequest.durationMs, language)}。`
      }),
      localize(language, {
        en: `Requested at: ${wakeRequest.requestedAt}.`,
        zh: `请求时间：${wakeRequest.requestedAt}。`
      }),
      localize(language, {
        en: `Wake time: ${wakeRequest.dueAt}.`,
        zh: `唤醒时间：${wakeRequest.dueAt}。`
      }),
      "",
      localize(language, {
        en: "Continue the waiting, polling, or monitoring task from this session now.",
        zh: "现在继续这个 session 里的等待、轮询或监控任务。"
      }),
      localize(language, {
        en: `If you still need more time, call ${WAKE_AFTER_TOOL_USAGE}.`,
        zh: `如果还需要更多时间，请调用 ${WAKE_AFTER_TOOL_USAGE}。`
      }),
      localize(language, {
        en: "This is a background wake-up turn. Its plain-text reply is not automatically posted back to chat.",
        zh: "这是一次后台唤醒 turn。它的普通文本回复不会自动发回聊天。"
      })
    ].join("\n");
  }

  private buildWorkerResultBinding(
    binding: ConversationBinding,
    worker: RepositoryBinding,
    sessionId: string | undefined,
    decision: ReturnType<typeof parseWorkerDecision>
  ): ConversationBinding {
    const wakeAction = [...decision.actions]
      .reverse()
      .find((action) => action.action === "wake_after");
    const now = new Date();
    const workerSessionId = sessionId ?? worker.workerSessionId;
    const nowIso = now.toISOString();

    if (wakeAction && !workerSessionId) {
      throw new Error("wake_after requires an active worker session id.");
    }

    return {
      ...binding,
      activeRepository: {
        ...worker,
        workerSessionId,
        pendingWakeRequest: wakeAction
          ? {
              id: randomUUID(),
              requestedAt: nowIso,
              dueAt: new Date(now.getTime() + wakeAction.durationMs).toISOString(),
              durationMs: wakeAction.durationMs
            }
          : undefined,
        updatedAt: nowIso
      },
      updatedAt: nowIso
    };
  }
}

function mergeHandlerDecision(
  responseText: string,
  nativeActions: HandlerDecision["actions"]
): HandlerDecision {
  if (!responseText.trim() && nativeActions.length > 0) {
    return {
      actions: nativeActions
    };
  }

  const parsed = parseHandlerDecision(responseText);
  if (nativeActions.length === 0) {
    return parsed;
  }

  return {
    ...parsed,
    actions: [...nativeActions, ...parsed.actions]
  };
}

function mergeWorkerDecision(
  responseText: string,
  nativeActions: WorkerControlAction[]
): ReturnType<typeof parseWorkerDecision> {
  const parsed = parseWorkerDecision(responseText);
  if (nativeActions.length === 0) {
    return parsed;
  }

  return {
    ...parsed,
    actions: [...nativeActions, ...parsed.actions]
  };
}

function buildDynamicToolTextResponse(
  text: string,
  success: boolean
): CodexDynamicToolCallResponse {
  return {
    contentItems: [
      {
        type: "inputText",
        text
      }
    ],
    success
  };
}

function describeHandlerToolAction(action: HandlerDecision["actions"][number]): string {
  switch (action.action) {
    case "bind_repo":
      return `Recorded repository binding to "${action.repositoryId}".`;
    case "delegate":
      return "Recorded worker delegation.";
    case "schedule_task":
      return `Recorded scheduled task request for "${action.repositoryId}".`;
    case "reset":
      return `Recorded reset request for scope "${action.scope}".`;
  }
}

function describeWorkerToolAction(
  action: WorkerControlAction,
  language: ConversationLanguage
): string {
  switch (action.action) {
    case "wake_after":
      return localize(language, {
        en: `Recorded wake-up request for ${formatWakeDuration(action.durationMs, language)}.`,
        zh: `已记录 ${formatWakeDuration(action.durationMs, language)}后的唤醒请求。`
      });
  }
}

function formatToolError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NOOP_TURN_PUBLISHER: TurnPublisher = {
  async publishQueued() {},
  async publishStarted() {},
  async publishProgress() {},
  async publishCompleted() {},
  async publishInterrupted() {},
  async publishFailed() {}
};
