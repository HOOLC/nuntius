import type { ProgressUpdateMode } from "./config.js";
import { localize } from "./conversation-language.js";
import type {
  CodexEvent,
  ConversationLanguage,
  InboundTurn
} from "./domain.js";
import type { TurnPublisher } from "./turn-publisher.js";
import { sanitizeUserFacingText } from "./user-facing-text.js";

const PROGRESS_HEARTBEAT_MS = 20_000;
const PROGRESS_DUPLICATE_WINDOW_MS = 4_000;
const MAX_PROGRESS_MESSAGES_PER_RUN = 14;

interface CodexProgressContext {
  actor: "handler" | "worker";
  repositoryId?: string;
  language: ConversationLanguage;
}

interface CodexProgressOptions {
  mode: ProgressUpdateMode;
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

export class CodexRunProgressReporter {
  private heartbeatTimer?: NodeJS.Timeout;
  private pending = Promise.resolve();
  private lastMessage?: string;
  private lastPublishedAt = 0;
  private sentCount = 0;
  private bufferedAgentMessage?: string;
  private sawTurnCompleted = false;
  private lastActivityAt = Date.now();
  private workingIndicatorVisible = false;
  private completedCommandCount = 0;
  private completedFileEditCount = 0;

  constructor(
    private readonly turn: InboundTurn,
    private readonly publisher: TurnPublisher,
    private readonly context: CodexProgressContext,
    private readonly options: CodexProgressOptions
  ) {}

  start(): void {
    if (!this.shouldPublishHeartbeats()) {
      return;
    }

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

    if (event.type === "turn.completed") {
      this.sawTurnCompleted = true;
      this.bufferedAgentMessage = undefined;
      return;
    }

    const progress = this.describeProgressEvent(event);
    if (!progress) {
      return;
    }

    if (!this.shouldPublishProgress(progress.kind)) {
      this.bufferedAgentMessage = undefined;
      return;
    }

    this.hideWorkingIndicator();

    if (progress.kind === "agent_message") {
      this.flushBufferedAgent();
      this.bufferedAgentMessage = progress.message;
      return;
    }

    this.flushBufferedAgent();
    this.enqueue(progress.message);
  }

  private describeProgressEvent(event: CodexEvent): ProgressMessage | undefined {
    if (event.type !== "item.completed") {
      return undefined;
    }

    return this.buildItemCompletedMessage(event.item);
  }

  private buildItemCompletedMessage(item: unknown): ProgressMessage | undefined {
    if (!isRecord(item)) {
      return undefined;
    }

    const toolSummary = this.buildToolSummaryMessage(item);
    if (toolSummary) {
      return toolSummary;
    }

    if (item.type === "agent_message" && typeof item.text === "string") {
      return toProgressMessage(normalizeProgressText(item.text), "agent_message");
    }

    return undefined;
  }

  private buildToolSummaryMessage(
    item: Record<string, unknown>
  ): ProgressMessage | undefined {
    if (item.type === "command_execution") {
      this.completedCommandCount += 1;
      return toProgressMessage(
        formatToolUsageSummary(
          this.context.language,
          this.completedCommandCount,
          this.completedFileEditCount
        ),
        "status"
      );
    }

    if (item.type === "file_change") {
      const fileEditCount = countFileEdits(item.changes);
      if (fileEditCount < 1) {
        return undefined;
      }

      this.completedFileEditCount += fileEditCount;
      return toProgressMessage(
        formatToolUsageSummary(
          this.context.language,
          this.completedCommandCount,
          this.completedFileEditCount
        ),
        "status"
      );
    }

    return undefined;
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
    if (!this.shouldPublishHeartbeats()) {
      return;
    }

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
        // Indicator failures should not abort the turn.
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
        // Indicator failures should not abort the turn.
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
        // Indicator failures should not abort the turn.
      }
    });
  }

  private flushBufferedAgent(): void {
    if (!this.bufferedAgentMessage) {
      return;
    }

    const message = this.bufferedAgentMessage;
    this.bufferedAgentMessage = undefined;

    if (!this.shouldPublishProgress("agent_message")) {
      return;
    }

    this.enqueue(message);
  }

  private shouldPublishHeartbeats(): boolean {
    return this.options.mode !== "off";
  }

  private shouldPublishProgress(kind: ProgressMessage["kind"]): boolean {
    switch (this.options.mode) {
      case "off":
        return false;
      case "minimal":
        return kind === "status";
      case "verbose":
        return true;
    }
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

function normalizeProgressText(text: string): string | undefined {
  const normalized = sanitizeUserFacingText(text).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function formatToolUsageSummary(
  language: ConversationLanguage,
  commandCount: number,
  fileEditCount: number
): string | undefined {
  const parts: string[] = [];

  if (commandCount > 0) {
    parts.push(
      localize(language, {
        en: `${commandCount} ${commandCount === 1 ? "command ran" : "commands ran"}`,
        zh: `已运行 ${commandCount} 个命令`
      })
    );
  }

  if (fileEditCount > 0) {
    parts.push(
      localize(language, {
        en: `${fileEditCount} ${fileEditCount === 1 ? "file change" : "file changes"}`,
        zh: `已完成 ${fileEditCount} 次文件修改`
      })
    );
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `${parts.join(", ")}.`;
}

function countFileEdits(changes: unknown): number {
  if (!Array.isArray(changes)) {
    return 0;
  }

  return changes.filter((change) => isRecord(change)).length;
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
