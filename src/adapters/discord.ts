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
import type { DiscordEditableMessage } from "../discord-delivery.js";
import {
  formatDiscordMessageText,
  trimCodeFencePayload
} from "../text-formatting.js";

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
  private progressMessage?: DiscordEditableMessage;

  constructor(private readonly envelope: DiscordEnvelope) {
    this.syncProcessingStatus = createProcessingStatusSynchronizer(envelope.syncStatusReaction);
  }

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
    await this.setProgressMessage(renderDiscordReply(message));
  }

  async publishCompleted(
    _: InboundTurn,
    message: OutboundMessage,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("finished");
    this.progressMessage = undefined;
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
    const reply = renderDiscordStatus(
      localize(language, {
        en: "Interrupted",
        zh: "已中断"
      }),
      message
    );
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
    if (this.progressMessage) {
      await this.progressMessage.edit(message);
      return;
    }

    if (this.envelope.postProgressMessage) {
      this.progressMessage = await this.envelope.postProgressMessage(message);
      return;
    }

    await this.envelope.followUp(message);
  }

  private async replaceProgressMessage(message: string): Promise<boolean> {
    if (!this.progressMessage) {
      return false;
    }

    await this.progressMessage.edit(message);
    this.progressMessage = undefined;
    return true;
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
