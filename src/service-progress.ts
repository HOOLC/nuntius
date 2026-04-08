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
  private latestAgentMessage?: string;
  private latestToolSummary?: string;
  private completedAgentCount = 0;
  private completedSearchCount = 0;
  private completedGlobCount = 0;
  private completedFileReadCount = 0;
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
      this.latestAgentMessage = progress.message;
      this.bufferedAgentMessage = progress.message;
      return;
    }

    this.flushBufferedAgent();
    this.enqueue(this.buildVisibleProgressMessage(progress));
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
    const usage = summarizeToolUsage(item);
    if (!usage) {
      return undefined;
    }

    this.completedAgentCount += usage.agentCount;
    this.completedSearchCount += usage.searchCount;
    this.completedGlobCount += usage.globCount;
    this.completedFileReadCount += usage.fileReadCount;
    this.completedCommandCount += usage.commandCount;
    this.completedFileEditCount += usage.fileEditCount;

    const summary = formatToolUsageSummary(this.context.language, {
        agentCount: this.completedAgentCount,
        searchCount: this.completedSearchCount,
        globCount: this.completedGlobCount,
        fileReadCount: this.completedFileReadCount,
        commandCount: this.completedCommandCount,
        fileEditCount: this.completedFileEditCount
      });
    this.latestToolSummary = summary;

    return toProgressMessage(summary, "status");
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

  getLatestToolSummary(): string | undefined {
    if (this.options.mode !== "latest") {
      return undefined;
    }

    return this.latestToolSummary;
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

    const message = this.buildVisibleProgressMessage({
      kind: "agent_message",
      message: this.bufferedAgentMessage
    });
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
      case "latest":
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

  private buildVisibleProgressMessage(progress: ProgressMessage): string {
    if (this.options.mode !== "latest") {
      return progress.message;
    }

    if (progress.kind === "status") {
      return combineLatestProgressMessage(this.latestAgentMessage, progress.message);
    }

    return combineLatestProgressMessage(progress.message, this.latestToolSummary);
  }
}

function combineLatestProgressMessage(
  primaryMessage: string | undefined,
  toolSummary: string | undefined
): string {
  return [primaryMessage?.trim(), toolSummary?.trim()].filter(Boolean).join("\n\n");
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
  counts: {
    agentCount: number;
    searchCount: number;
    globCount: number;
    fileReadCount: number;
    commandCount: number;
    fileEditCount: number;
  }
): string | undefined {
  const parts: string[] = [];

  if (counts.agentCount > 0) {
    parts.push(
      localize(language, {
        en: `🤖 ${counts.agentCount} ${counts.agentCount === 1 ? "agent" : "agents"}`,
        zh: `🤖 ${counts.agentCount} 个 agent`
      })
    );
  }

  if (counts.searchCount > 0) {
    parts.push(
      localize(language, {
        en: `🔍 ${counts.searchCount} ${counts.searchCount === 1 ? "search" : "searches"}`,
        zh: `🔍 ${counts.searchCount} 次搜索`
      })
    );
  }

  if (counts.globCount > 0) {
    parts.push(
      localize(language, {
        en: `🔍 ${counts.globCount} ${counts.globCount === 1 ? "glob" : "globs"}`,
        zh: `🔍 ${counts.globCount} 次 glob`
      })
    );
  }

  if (counts.fileReadCount > 0) {
    parts.push(
      localize(language, {
        en: `📖 ${counts.fileReadCount} ${counts.fileReadCount === 1 ? "file" : "files"}`,
        zh: `📖 ${counts.fileReadCount} 个文件`
      })
    );
  }

  if (counts.commandCount > 0) {
    parts.push(
      localize(language, {
        en: `⚙️ ${counts.commandCount} ${counts.commandCount === 1 ? "cmd" : "cmds"}`,
        zh: `⚙️ ${counts.commandCount} 条命令`
      })
    );
  }

  if (counts.fileEditCount > 0) {
    parts.push(
      localize(language, {
        en: `✏️ ${counts.fileEditCount} ${counts.fileEditCount === 1 ? "edit" : "edits"}`,
        zh: `✏️ ${counts.fileEditCount} 处修改`
      })
    );
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join(" · ");
}

function countFileEdits(changes: unknown): number {
  if (!Array.isArray(changes)) {
    return 0;
  }

  return changes.filter((change) => isRecord(change)).length;
}

function summarizeToolUsage(item: Record<string, unknown>): {
  agentCount: number;
  searchCount: number;
  globCount: number;
  fileReadCount: number;
  commandCount: number;
  fileEditCount: number;
} | undefined {
  const toolId = readToolIdentifier(item);

  if (item.type === "command_execution" || toolId === "exec_command") {
    return {
      agentCount: 0,
      searchCount: 0,
      globCount: 0,
      fileReadCount: 0,
      commandCount: 1,
      fileEditCount: 0
    };
  }

  if (item.type === "file_change" || toolId === "apply_patch") {
    const fileEditCount = countFileEdits(item.changes);
    if (fileEditCount < 1) {
      return undefined;
    }

    return {
      agentCount: 0,
      searchCount: 0,
      globCount: 0,
      fileReadCount: 0,
      commandCount: 0,
      fileEditCount
    };
  }

  if (toolId === "spawn_agent" || item.type === "spawn_agent" || item.type === "agent_spawn") {
    return withSingleCategory("agentCount", readUsageCount(item, {
      numericKeys: ["count", "agentCount", "agent_count"],
      arrayKeys: ["agents", "agentIds", "agent_ids", "targets"]
    }));
  }

  if (
    toolId === "search_query" ||
    toolId === "image_query" ||
    item.type === "search_query" ||
    item.type === "web_search" ||
    item.type === "search"
  ) {
    return withSingleCategory("searchCount", readUsageCount(item, {
      numericKeys: ["count", "queryCount", "query_count", "searchCount", "search_count"],
      arrayKeys: ["queries", "searches", "search_query", "image_query"]
    }));
  }

  if (toolId === "glob" || item.type === "glob" || item.type === "file_glob") {
    return withSingleCategory("globCount", readUsageCount(item, {
      numericKeys: ["count", "globCount", "glob_count"],
      arrayKeys: ["globs", "patterns", "paths"]
    }));
  }

  if (
    toolId === "read_file" ||
    toolId === "open_file" ||
    item.type === "file_read" ||
    item.type === "read_file" ||
    item.type === "open_file"
  ) {
    return withSingleCategory("fileReadCount", readUsageCount(item, {
      numericKeys: ["count", "fileCount", "file_count"],
      arrayKeys: ["files", "paths"]
    }));
  }

  return undefined;
}

function withSingleCategory(
  key: "agentCount" | "searchCount" | "globCount" | "fileReadCount",
  value: number
): {
  agentCount: number;
  searchCount: number;
  globCount: number;
  fileReadCount: number;
  commandCount: number;
  fileEditCount: number;
} | undefined {
  if (value < 1) {
    return undefined;
  }

  return {
    agentCount: key === "agentCount" ? value : 0,
    searchCount: key === "searchCount" ? value : 0,
    globCount: key === "globCount" ? value : 0,
    fileReadCount: key === "fileReadCount" ? value : 0,
    commandCount: 0,
    fileEditCount: 0
  };
}

function readUsageCount(
  item: Record<string, unknown>,
  input: {
    numericKeys: string[];
    arrayKeys: string[];
  }
): number {
  for (const key of input.numericKeys) {
    const value = item[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  for (const key of input.arrayKeys) {
    const value = item[key];
    if (Array.isArray(value) && value.length > 0) {
      return value.length;
    }
  }

  return 1;
}

function readToolIdentifier(item: Record<string, unknown>): string | undefined {
  const candidates = [
    item.name,
    item.tool_name,
    item.toolName,
    item.type
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
    }
  }

  return undefined;
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
