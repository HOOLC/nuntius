import type {
  Attachment,
  ConversationBinding,
  InboundTurn,
  OutboundMessage,
  ProcessingStatus
} from "../domain.js";
import type { InteractionRouter } from "../interaction-router.js";
import type { TurnPublisher } from "../service.js";

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

    const turn: InboundTurn = {
      platform: "feishu",
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

    await this.router.handleTurn(turn, new FeishuPublisher(envelope));
  }
}

class FeishuPublisher implements TurnPublisher {
  private workingPlaceholderMessageId?: string;
  private processingStatus?: ProcessingStatus;

  constructor(private readonly envelope: FeishuEnvelope) {}

  async publishQueued(): Promise<void> {
    await this.syncProcessingStatus("queued");
    await this.envelope.postMessage(
      renderFeishuStatus("Queued", "Queued behind the active Codex turn for this conversation.")
    );
  }

  async publishStarted(
    _: InboundTurn,
    _binding: ConversationBinding,
    _note?: string
  ): Promise<void> {
    await this.syncProcessingStatus("working");
  }

  async publishProgress(_: InboundTurn, message: string): Promise<void> {
    await this.syncProcessingStatus("working");
    const progressMessage = renderFeishuTextMessage(message);
    if (await this.replaceWorkingPlaceholder(progressMessage)) {
      return;
    }

    await this.envelope.postMessage(progressMessage);
  }

  async publishCompleted(_: InboundTurn, message: OutboundMessage): Promise<void> {
    await this.syncProcessingStatus("finished");
    const replyMessage = renderFeishuReply(message.text, message.truncated);
    if (!(await this.replaceWorkingPlaceholder(replyMessage))) {
      await this.envelope.postMessage(replyMessage);
    }

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
            "Attachment upload failed",
            `Could not return "${attachment.name}": ${formatAttachmentFailure(error)}`
          )
        );
      }
    }
  }

  async publishInterrupted(_: InboundTurn, message: string): Promise<void> {
    await this.syncProcessingStatus("interrupted");
    if (await this.replaceWorkingPlaceholder(renderFeishuStatus("Interrupted", message))) {
      return;
    }

    await this.envelope.postMessage(renderFeishuStatus("Interrupted", message));
  }

  async publishFailed(_: InboundTurn, errorMessage: string): Promise<void> {
    await this.syncProcessingStatus("failed");
    if (await this.replaceWorkingPlaceholder(renderFeishuError(errorMessage))) {
      return;
    }

    await this.envelope.postMessage(renderFeishuError(errorMessage));
  }

  async refreshWorkingIndicator(): Promise<void> {
    await this.syncProcessingStatus("working");
    const placeholder = renderFeishuStatus(
      "Working",
      `Still working. Last update: ${formatFeishuWorkingTimestamp(new Date())}`
    );

    if (this.workingPlaceholderMessageId && this.envelope.updateMessage) {
      await this.envelope.updateMessage(this.workingPlaceholderMessageId, placeholder);
      return;
    }

    const result = await this.envelope.postMessage(placeholder);
    if (result.messageId && this.envelope.updateMessage) {
      this.workingPlaceholderMessageId = result.messageId;
    }
  }

  async hideWorkingIndicator(): Promise<void> {
    return undefined;
  }

  private async syncProcessingStatus(status: ProcessingStatus): Promise<void> {
    if (!this.envelope.syncStatusReaction || this.processingStatus === status) {
      return;
    }

    try {
      await this.envelope.syncStatusReaction(status);
      this.processingStatus = status;
    } catch {
      // Reaction failures should not abort the Feishu turn.
    }
  }

  private async replaceWorkingPlaceholder(message: FeishuChatMessage): Promise<boolean> {
    if (!this.workingPlaceholderMessageId || !this.envelope.updateMessage) {
      return false;
    }

    await this.envelope.updateMessage(this.workingPlaceholderMessageId, message);
    this.workingPlaceholderMessageId = undefined;
    return true;
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

function renderFeishuReply(body: string, truncated: boolean | undefined): FeishuChatMessage {
  const normalizedBody = body.trim();
  const suffix = truncated ? "\n\nReply truncated for Feishu delivery." : "";
  return renderFeishuTextMessage(`${normalizedBody}${suffix}`.trim());
}

function renderFeishuError(errorMessage: string): FeishuChatMessage {
  return renderFeishuTextMessage(
    ["[Failed]", "Codex could not complete this turn.", "", trimCodeFencePayload(errorMessage)].join("\n")
  );
}

function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
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
