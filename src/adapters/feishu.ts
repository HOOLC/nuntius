import type {
  Attachment,
  ConversationBinding,
  InboundTurn,
  OutboundMessage
} from "../domain.js";
import { buildCodexNetworkAccessStartNote } from "../codex-network-access.js";
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

  constructor(private readonly envelope: FeishuEnvelope) {}

  async publishQueued(): Promise<void> {
    await this.envelope.postMessage(
      renderFeishuStatus("Queued", "Queued behind the active Codex turn for this conversation.")
    );
  }

  async publishStarted(
    _: InboundTurn,
    binding: ConversationBinding,
    note?: string
  ): Promise<void> {
    const activeRepository = binding.activeRepository;
    const networkNote = activeRepository
      ? buildCodexNetworkAccessStartNote(activeRepository)
      : undefined;
    const message = activeRepository
      ? [
          note ? `Context:\n${note}` : undefined,
          `Repository: "${activeRepository.repositoryId}"`,
          `Sandbox: ${activeRepository.sandboxMode}`,
          activeRepository.workerSessionId
            ? `Worker session: ${activeRepository.workerSessionId}`
            : undefined,
          networkNote ? `Network: ${networkNote}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      : note ?? "Running the handler Codex session.";

    await this.envelope.postMessage(renderFeishuStatus("Started", message));
  }

  async publishProgress(_: InboundTurn, message: string): Promise<void> {
    if (await this.replaceWorkingPlaceholder(renderFeishuStatus("Working", message))) {
      return;
    }

    await this.envelope.postMessage(renderFeishuStatus("Working", message));
  }

  async publishCompleted(_: InboundTurn, message: OutboundMessage): Promise<void> {
    if (
      !(await this.replaceWorkingPlaceholder(
        renderFeishuStatus("Completed", "Finished this Codex turn.")
      ))
    ) {
      await this.envelope.postMessage(renderFeishuStatus("Completed", "Finished this Codex turn."));
    }

    await this.envelope.postMessage(renderFeishuReply(message.text, message.truncated));

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
    if (await this.replaceWorkingPlaceholder(renderFeishuStatus("Interrupted", message))) {
      return;
    }

    await this.envelope.postMessage(renderFeishuStatus("Interrupted", message));
  }

  async publishFailed(_: InboundTurn, errorMessage: string): Promise<void> {
    if (await this.replaceWorkingPlaceholder(renderFeishuError(errorMessage))) {
      return;
    }

    await this.envelope.postMessage(renderFeishuError(errorMessage));
  }

  async refreshWorkingIndicator(): Promise<void> {
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
