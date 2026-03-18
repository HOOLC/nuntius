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
import type { TurnPublisher } from "../service.js";

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
  deferReply: () => Promise<void>;
  startTyping?: () => Promise<{ stop(): Promise<void> }>;
  followUp: (message: string) => Promise<void>;
  syncStatusReaction?: (status: ProcessingStatus) => Promise<void>;
}

export class DiscordAdapter {
  constructor(private readonly router: InteractionRouter) {}

  async handleTurn(envelope: DiscordEnvelope): Promise<void> {
    await envelope.deferReply();
    const turn: InboundTurn = {
      platform: "discord",
      workspaceId: envelope.workspaceId,
      channelId: envelope.channelId,
      threadId: envelope.threadId,
      scope: envelope.scope,
      userId: envelope.userId,
      userDisplayName: envelope.userDisplayName,
      text: envelope.text,
      attachments: envelope.attachments ?? [],
      repositoryId: envelope.repositoryId,
      receivedAt: envelope.receivedAt ?? new Date().toISOString()
    };

    await this.router.handleTurn(turn, new DiscordPublisher(envelope));
  }
}

class DiscordPublisher implements TurnPublisher {
  private typingLease?: {
    stop(): Promise<void>;
  };
  private processingStatus?: ProcessingStatus;

  constructor(private readonly envelope: DiscordEnvelope) {}

  async publishQueued(_: InboundTurn, language: ConversationLanguage): Promise<void> {
    await this.syncProcessingStatus("queued");
    await this.envelope.followUp(
      renderDiscordStatus(
        localize(language, {
          en: "Queued",
          zh: "已排队"
        }),
        localize(language, {
          en: "Waiting for the active Codex turn in this conversation.",
          zh: "当前会话已有进行中的 Codex turn，正在等待。"
        })
      )
    );
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
    _language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("working");
    await this.envelope.followUp(renderDiscordReply(message));
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
    await this.envelope.followUp(renderDiscordReply(`${message.text}${suffix}`));
  }

  async publishInterrupted(
    _: InboundTurn,
    message: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("interrupted");
    await this.envelope.followUp(
      renderDiscordStatus(
        localize(language, {
          en: "Interrupted",
          zh: "已中断"
        }),
        message
      )
    );
  }

  async publishFailed(
    _: InboundTurn,
    errorMessage: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("failed");
    await this.envelope.followUp(renderDiscordError(errorMessage, language));
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

  private async syncProcessingStatus(status: ProcessingStatus): Promise<void> {
    if (!this.envelope.syncStatusReaction || this.processingStatus === status) {
      return;
    }

    try {
      await this.envelope.syncStatusReaction(status);
      this.processingStatus = status;
    } catch {
      // Reaction failures should not abort the Discord turn.
    }
  }
}

function renderDiscordStatus(title: string, body: string): string {
  const normalizedBody = body.trim();
  const quotedBody = normalizedBody
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  return [`**${title}**`, quotedBody].join("\n");
}

function renderDiscordReply(body: string): string {
  return body.trim();
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

function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
}
