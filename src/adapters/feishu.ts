import type {
  Attachment,
  ConversationBinding,
  InboundTurn,
  OutboundMessage
} from "../domain.js";
import { buildCodexNetworkAccessStartNote } from "../codex-network-access.js";
import type { InteractionRouter } from "../interaction-router.js";
import type { TurnPublisher } from "../service.js";

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
  postMessage: (message: string) => Promise<{ messageId?: string }>;
  updateMessage?: (messageId: string, message: string) => Promise<void>;
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
  private statusMessageId?: string;

  constructor(private readonly envelope: FeishuEnvelope) {}

  async publishQueued(): Promise<void> {
    await this.setStatusMessage("Queued", "Queued behind the active Codex turn for this conversation.");
  }

  async publishStarted(
    _: InboundTurn,
    binding: ConversationBinding,
    note?: string
  ): Promise<void> {
    const activeRepository = binding.activeRepository;
    const message = activeRepository
      ? [
          note,
          `Running worker Codex against "${activeRepository.repositoryId}" (${activeRepository.sandboxMode})${
            activeRepository.workerSessionId ? ` session=${activeRepository.workerSessionId}` : ""
          }.`,
          buildCodexNetworkAccessStartNote(activeRepository)
        ]
          .filter(Boolean)
          .join("\n")
      : note ?? "Running the handler Codex session.";

    await this.setStatusMessage("Started", message);
  }

  async publishProgress(_: InboundTurn, message: string): Promise<void> {
    await this.setStatusMessage("Working", message);
  }

  async publishCompleted(_: InboundTurn, message: OutboundMessage): Promise<void> {
    if (this.statusMessageId && this.envelope.updateMessage) {
      await this.tryUpdateStatusMessage(this.statusMessageId, renderFeishuStatus("Completed", "Finished this Codex turn."));
    }

    const suffix = message.truncated ? "\n\nReply was truncated for chat delivery." : "";
    await this.envelope.postMessage(`${message.text}${suffix}`);
  }

  async publishFailed(_: InboundTurn, errorMessage: string): Promise<void> {
    if (this.statusMessageId && this.envelope.updateMessage) {
      await this.tryUpdateStatusMessage(
        this.statusMessageId,
        renderFeishuStatus("Failed", "Codex could not complete this turn.")
      );
    }

    await this.envelope.postMessage(renderFeishuError(errorMessage));
  }

  private async setStatusMessage(title: string, body: string): Promise<void> {
    const content = renderFeishuStatus(title, body);

    if (this.statusMessageId && this.envelope.updateMessage) {
      const updated = await this.tryUpdateStatusMessage(this.statusMessageId, content);
      if (updated) {
        return;
      }
    }

    const result = await this.envelope.postMessage(content);
    if (result.messageId) {
      this.statusMessageId = result.messageId;
    }
  }

  private async tryUpdateStatusMessage(messageId: string, content: string): Promise<boolean> {
    if (!this.envelope.updateMessage) {
      return false;
    }

    try {
      await this.envelope.updateMessage(messageId, content);
      return true;
    } catch {
      return false;
    }
  }
}

function renderFeishuStatus(title: string, body: string): string {
  const normalizedBody = body.trim();
  if (!normalizedBody) {
    return title;
  }

  return `${title}\n${normalizedBody}`;
}

function renderFeishuError(errorMessage: string): string {
  return [
    "Codex failed",
    "",
    trimCodeFencePayload(errorMessage)
  ].join("\n");
}

function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
}
