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

  return undefined;
}

function normalizeProgressText(text: string): string | undefined {
  const normalized = sanitizeUserFacingText(text).trim();
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
