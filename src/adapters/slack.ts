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
import { trimCodeFencePayload } from "../text-formatting.js";

export interface SlackEnvelope {
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
  acknowledge: () => Promise<void>;
  postMessage: (message: string) => Promise<{ messageTs?: string }>;
  updateMessage?: (messageTs: string, message: string) => Promise<void>;
  postEphemeral?: (message: string) => Promise<void>;
  syncStatusReaction?: (status: ProcessingStatus) => Promise<void>;
}

export class SlackAdapter {
  constructor(private readonly router: InteractionRouter) {}

  async handleTurn(envelope: SlackEnvelope): Promise<void> {
    await envelope.acknowledge();
    const turn = buildInboundTurn("slack", envelope);

    await this.router.handleTurn(turn, new SlackPublisher(envelope));
  }
}

class SlackPublisher implements TurnPublisher {
  private readonly syncProcessingStatus: (status: ProcessingStatus) => Promise<void>;
  private statusMessageTs?: string;

  constructor(private readonly envelope: SlackEnvelope) {
    this.syncProcessingStatus = createProcessingStatusSynchronizer(envelope.syncStatusReaction);
  }

  async publishQueued(_: InboundTurn, language: ConversationLanguage): Promise<void> {
    await this.syncProcessingStatus("queued");
    if (this.envelope.postEphemeral) {
      await this.envelope.postEphemeral(
        localize(language, {
          en: "Queued behind the active Codex turn for this thread.",
          zh: "当前线程已有进行中的 Codex turn，本条消息已进入队列。"
        })
      );
      return;
    }

    await this.setStatusMessage(
      localize(language, {
        en: "Queued",
        zh: "已排队"
      }),
      localize(language, {
        en: "Queued behind the active Codex turn for this thread.",
        zh: "当前线程已有进行中的 Codex turn，本条消息已进入队列。"
      })
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
    await this.setMessage(message);
  }

  async publishCompleted(
    _: InboundTurn,
    message: OutboundMessage,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("finished");
    const suffix = message.truncated
      ? localize(language, {
          en: "\n\nReply was truncated for chat delivery.",
          zh: "\n\n回复因聊天平台限制已被截断。"
        })
      : "";
    await this.envelope.postMessage(`${message.text}${suffix}`);
  }

  async publishInterrupted(
    _: InboundTurn,
    message: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("interrupted");
    await this.setStatusMessage(
      localize(language, {
        en: "Interrupted",
        zh: "已中断"
      }),
      message
    );
  }

  async publishFailed(
    _: InboundTurn,
    errorMessage: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("failed");
    if (this.statusMessageTs && this.envelope.updateMessage) {
      await this.envelope.updateMessage(
        this.statusMessageTs,
        renderSlackStatus(
          localize(language, {
            en: "Failed",
            zh: "失败"
          }),
          localize(language, {
            en: "Codex could not complete this turn.",
            zh: "Codex 未能完成这次 turn。"
          })
        )
      );
    }

    await this.envelope.postMessage(renderSlackError(errorMessage, language));
  }
  private async setStatusMessage(title: string, body: string): Promise<void> {
    const content = renderSlackStatus(title, body);
    await this.setMessage(content);
  }

  private async setMessage(message: string): Promise<void> {
    if (this.statusMessageTs && this.envelope.updateMessage) {
      await this.envelope.updateMessage(this.statusMessageTs, message);
      return;
    }

    const result = await this.envelope.postMessage(message);
    if (result.messageTs) {
      this.statusMessageTs = result.messageTs;
    }
  }
}

function renderSlackStatus(title: string, body: string): string {
  const normalizedBody = body.trim();
  if (!normalizedBody) {
    return `*${title}*`;
  }

  const quotedBody = normalizedBody
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  return `*${title}*\n${quotedBody}`;
}

function renderSlackError(errorMessage: string, language: ConversationLanguage): string {
  return [
    localize(language, {
      en: "*Codex failed*",
      zh: "*Codex 失败*"
    }),
    "```",
    trimCodeFencePayload(errorMessage),
    "```"
  ].join("\n");
}
