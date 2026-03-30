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

export interface FeishuChatMessage {
  msgType: "file" | "interactive" | "text";
  content: string;
}

export interface FeishuEnvelope {
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
  postMessage: (message: FeishuChatMessage) => Promise<{ messageId?: string }>;
  updateMessage?: (messageId: string, message: FeishuChatMessage) => Promise<void>;
  uploadFile?: (input: {
    localPath: string;
    name: string;
    mimeType?: string;
  }) => Promise<{ fileKey: string }>;
  syncStatusReaction?: (status: ProcessingStatus) => Promise<void>;
}

export class FeishuAdapter {
  constructor(private readonly router: InteractionRouter) {}

  async handleTurn(envelope: FeishuEnvelope): Promise<void> {
    await envelope.acknowledge();
    const turn = buildInboundTurn("feishu", envelope);

    await this.router.handleTurn(turn, new FeishuPublisher(envelope));
  }
}

class FeishuPublisher implements TurnPublisher {
  private readonly syncProcessingStatus: (status: ProcessingStatus) => Promise<void>;
  private progressMessageId?: string;

  constructor(private readonly envelope: FeishuEnvelope) {
    this.syncProcessingStatus = createProcessingStatusSynchronizer(envelope.syncStatusReaction);
  }

  async publishQueued(_: InboundTurn, language: ConversationLanguage): Promise<void> {
    await this.syncProcessingStatus("queued");
    await this.envelope.postMessage(
      renderFeishuStatus(
        localize(language, {
          en: "Queued",
          zh: "已排队"
        }),
        localize(language, {
          en: "Queued behind the active Codex turn for this conversation.",
          zh: "当前会话已有进行中的 Codex turn，本条消息已进入队列。"
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
    await this.setProgressMessage(renderFeishuTextMessage(message));
  }

  async publishCompleted(
    _: InboundTurn,
    message: OutboundMessage,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("finished");
    const replyMessage = renderFeishuReply(message.text, message.truncated, language);
    await this.envelope.postMessage(replyMessage);

    if (!this.envelope.uploadFile) {
      return;
    }

    for (const attachment of message.attachments ?? []) {
      try {
        const uploaded = await this.envelope.uploadFile({
          localPath: attachment.localPath,
          name: attachment.name,
          mimeType: attachment.mimeType
        });
        await this.envelope.postMessage(renderFeishuFileMessage(uploaded.fileKey));
      } catch (error) {
        await this.envelope.postMessage(
          renderFeishuStatus(
            localize(language, {
              en: "Attachment upload failed",
              zh: "附件上传失败"
            }),
            localize(language, {
              en: `Could not return "${attachment.name}": ${formatAttachmentFailure(error)}`,
              zh: `无法返回 "${attachment.name}"：${formatAttachmentFailure(error)}`
            })
          )
        );
      }
    }
  }

  async publishInterrupted(
    _: InboundTurn,
    message: string,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("interrupted");
    await this.envelope.postMessage(
      renderFeishuStatus(
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
    await this.envelope.postMessage(renderFeishuError(errorMessage, language));
  }

  async refreshWorkingIndicator(
    _turn: InboundTurn,
    language: ConversationLanguage
  ): Promise<void> {
    await this.syncProcessingStatus("working");
    await this.setProgressMessage(
      renderFeishuStatus(
        localize(language, {
          en: "Working",
          zh: "处理中"
        }),
        localize(language, {
          en: `Still working. Last update: ${formatFeishuWorkingTimestamp(new Date())}`,
          zh: `仍在处理中。最近更新：${formatFeishuWorkingTimestamp(new Date())}`
        })
      )
    );
  }

  async hideWorkingIndicator(
    _turn: InboundTurn,
    _language: ConversationLanguage
  ): Promise<void> {
    return undefined;
  }

  private async setProgressMessage(message: FeishuChatMessage): Promise<void> {
    if (this.progressMessageId && this.envelope.updateMessage) {
      await this.envelope.updateMessage(this.progressMessageId, message);
      return;
    }

    const result = await this.envelope.postMessage(message);
    if (result.messageId && this.envelope.updateMessage) {
      this.progressMessageId = result.messageId;
    }
  }
}

export function renderFeishuNotice(title: string, body: string): FeishuChatMessage {
  return renderFeishuTextMessage([title, "", body.trim()].filter(Boolean).join("\n"));
}

export function renderFeishuTextMessage(text: string): FeishuChatMessage {
  return {
    msgType: "text",
    content: JSON.stringify({
      text
    })
  };
}

function renderFeishuFileMessage(fileKey: string): FeishuChatMessage {
  return {
    msgType: "file",
    content: JSON.stringify({
      file_key: fileKey
    })
  };
}

function renderFeishuStatus(title: string, body: string): FeishuChatMessage {
  const normalizedBody = body.trim();
  const text = normalizedBody
    ? [`[${title}]`, normalizedBody].join("\n")
    : `[${title}]`;

  return renderFeishuTextMessage(text);
}

function renderFeishuReply(
  body: string,
  truncated: boolean | undefined,
  language: ConversationLanguage
): FeishuChatMessage {
  const normalizedBody = body.trim();
  const suffix = truncated
    ? localize(language, {
        en: "\n\nReply truncated for Feishu delivery.",
        zh: "\n\n回复因飞书投递限制已被截断。"
      })
    : "";
  return renderFeishuTextMessage(`${normalizedBody}${suffix}`.trim());
}

function renderFeishuError(
  errorMessage: string,
  language: ConversationLanguage
): FeishuChatMessage {
  return renderFeishuTextMessage(
    [
      localize(language, {
        en: "[Failed]",
        zh: "[失败]"
      }),
      localize(language, {
        en: "Codex could not complete this turn.",
        zh: "Codex 未能完成这次 turn。"
      }),
      "",
      trimCodeFencePayload(errorMessage)
    ].join("\n")
  );
}

function formatFeishuWorkingTimestamp(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function formatAttachmentFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "unknown upload error";
}
