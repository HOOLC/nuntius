import type { ProgressUpdateMode } from "../config.js";
import { localize } from "../conversation-language.js";
import type {
  Attachment,
  ConversationBinding,
  ConversationLanguage,
  InboundTurn,
  OutboundMessage,
  ProcessingStatus
} from "../domain.js";
import type { InteractionRouter } from "../interaction-router.js";
import type { TurnPublisher } from "../turn-publisher.js";
import {
  buildInboundTurn,
  createProcessingStatusSynchronizer
} from "./shared.js";
import {
  type DiscordEditableMessage,
  splitDiscordMessage
} from "../discord-delivery.js";
import {
  formatDiscordMessageText,
  trimCodeFencePayload
} from "../text-formatting.js";
import {
  buildInitialToolSummary,
  splitLatestProgressMessage
} from "../latest-progress.js";

export interface DiscordEnvelope {
  workspaceId: string;
  channelId: string;
  threadId?: string;
  scope: InboundTurn["scope"];
  userId: string;
  userDisplayName?: string;
  text: string;
  attachments?: Attachment[];
  repositoryId?: string;
  receivedAt?: string;
  progressMode?: ProgressUpdateMode;
  deferReply: () => Promise<void>;
  startTyping?: () => Promise<{ stop(): Promise<void> }>;
  followUp: (message: string) => Promise<void>;
  postProgressMessage?: (message: string) => Promise<DiscordEditableMessage | undefined>;
  syncStatusReaction?: (status: ProcessingStatus) => Promise<void>;
}

export class DiscordAdapter {
  constructor(private readonly router: InteractionRouter) {}

  async handleTurn(envelope: DiscordEnvelope): Promise<void> {
    await envelope.deferReply();
    const turn = buildInboundTurn("discord", envelope);

    await this.router.handleTurn(turn, new DiscordPublisher(envelope));
  }
}

class DiscordPublisher implements TurnPublisher {
  private readonly syncProcessingStatus: (status: ProcessingStatus) => Promise<void>;
  private typingLease?: {
    stop(): Promise<void>;
  };
  private toolSummaryMessage?: DiscordEditableMessage;
  private progressMessage?: DiscordEditableMessage;

  constructor(private readonly envelope: DiscordEnvelope) {
    this.syncProcessingStatus = createProcessingStatusSynchronizer(envelope.syncStatusReaction);
  }

  async publishQueued(_: InboundTurn, language: ConversationLanguage): Promise<void> {
    await this.syncProcessingStatus("queued");
    const reply = renderDiscordStatus(
      localize(language, {
        en: "Queued",
        zh: "已排队"
      }),
      localize(language, {
        en: "Waiting for the active Codex turn in this conversation.",
        zh: "当前会话已有进行中的 Codex turn，正在等待。"
      })
    );

    if (this.shouldReplaceLatestMessage()) {
      await this.publishLatestModeMessages(reply, language);
      return;
    }

    await this.envelope.followUp(reply);
  }

  async publishStarted(
    _turn: InboundTurn,
    _binding: ConversationBinding,
    _note: string | undefined,
    _language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("working");
  }

  async publishProgress(
    _: InboundTurn,
    message: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("working");
    if (this.shouldReplaceLatestMessage()) {
      await this.publishLatestModeMessages(renderDiscordReply(message), language);
      return;
    }

    await this.setProgressMessage(renderDiscordReply(message));
  }

  async publishCompleted(
    _: InboundTurn,
    message: OutboundMessage,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("finished");
    const suffix = message.truncated
      ? localize(language, {
          en: "\n\n_Reply truncated for Discord delivery._",
          zh: "\n\n_回复因 Discord 投递限制已被截断。_"
        })
      : "";
    const reply = renderDiscordReply(`${message.text}${suffix}`);
    if (this.shouldReplaceLatestMessage()) {
      await this.publishLatestModeMessages(reply, language);
      return;
    }

    this.progressMessage = undefined;
    await this.envelope.followUp(reply);
  }

  async publishInterrupted(
    _: InboundTurn,
    message: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("interrupted");
    const reply = renderDiscordStatus(
      localize(language, {
        en: "Interrupted",
        zh: "已中断"
      }),
      message
    );
    if (this.shouldReplaceLatestMessage()) {
      await this.publishLatestModeMessages(reply, language);
      return;
    }

    if (await this.replaceProgressMessage(reply)) {
      return;
    }

    await this.envelope.followUp(reply);
  }

  async publishFailed(
    _: InboundTurn,
    errorMessage: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("failed");
    const reply = renderDiscordError(errorMessage, language);
    if (this.shouldReplaceLatestMessage()) {
      await this.publishLatestModeMessages(reply, language);
      return;
    }

    if (await this.replaceProgressMessage(reply)) {
      return;
    }

    await this.envelope.followUp(reply);
  }

  async showWorkingIndicator(
    _turn: InboundTurn,
    _language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("working");
    if (this.typingLease || !this.envelope.startTyping) {
      return;
    }

    try {
      this.typingLease = await this.envelope.startTyping();
    } catch {
      // Typing failures should not abort the Discord turn.
    }
  }

  async hideWorkingIndicator(
    _turn: InboundTurn,
    _language: ConversationLanguage
  ): Promise<void> {
    const lease = this.typingLease;
    if (!lease) {
      return;
    }

    this.typingLease = undefined;

    try {
      await lease.stop();
    } catch {
      // Typing failures should not abort the Discord turn.
    }
  }

  private async setProgressMessage(message: string): Promise<void> {
    this.progressMessage = await this.setTrackedMessage(this.progressMessage, message);
  }

  private async setToolSummaryMessage(message: string): Promise<void> {
    this.toolSummaryMessage = await this.setTrackedMessage(this.toolSummaryMessage, message);
  }

  private async setTrackedMessage(
    currentMessage: DiscordEditableMessage | undefined,
    message: string
  ): Promise<DiscordEditableMessage | undefined> {
    const chunks = splitDiscordMessage(message);
    if (chunks.length === 0) {
      return currentMessage;
    }

    if (currentMessage) {
      await currentMessage.edit(chunks[0]);
      if (chunks.length > 1) {
        for (const chunk of chunks.slice(1)) {
          await this.envelope.followUp(chunk);
        }
        return undefined;
      }

      return currentMessage;
    }

    if (this.envelope.postProgressMessage) {
      const nextMessage = await this.envelope.postProgressMessage(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await this.envelope.followUp(chunk);
      }
      return chunks.length === 1 ? nextMessage : undefined;
    }

    for (const chunk of chunks) {
      await this.envelope.followUp(chunk);
    }

    return undefined;
  }

  private async replaceProgressMessage(message: string): Promise<boolean> {
    if (!this.progressMessage) {
      return false;
    }

    await this.setProgressMessage(message);
    this.progressMessage = undefined;
    return true;
  }

  private shouldReplaceLatestMessage(): boolean {
    return this.envelope.progressMode === "latest";
  }

  private async publishLatestModeMessages(
    message: string,
    language: ConversationLanguage
  ): Promise<void> {
    const parts = splitLatestProgressMessage(message);

    if (parts.toolSummary) {
      await this.setToolSummaryMessage(parts.toolSummary);
    } else if (parts.latestMessage && !this.toolSummaryMessage) {
      await this.setToolSummaryMessage(buildInitialToolSummary(language));
    }

    if (parts.latestMessage) {
      await this.setProgressMessage(parts.latestMessage);
    }
  }
}

function renderDiscordStatus(title: string, body: string): string {
  const normalizedBody = formatDiscordMessageText(body).trim();
  const quotedBody = normalizedBody
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  return [`**${title}**`, quotedBody].join("\n");
}

function renderDiscordReply(body: string): string {
  return formatDiscordMessageText(body).trim();
}

function renderDiscordError(
  errorMessage: string,
  language: ConversationLanguage
): string {
  return [
    localize(language, {
      en: "**Codex failed**",
      zh: "**Codex 失败**"
    }),
    "```text",
    trimCodeFencePayload(errorMessage),
    "```"
  ].join("\n");
}
