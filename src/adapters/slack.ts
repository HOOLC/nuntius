import type {
  Attachment,
  ConversationBinding,
  InboundTurn,
  OutboundMessage,
  ProcessingStatus
} from "../domain.js";
import type { InteractionRouter } from "../interaction-router.js";
import type { TurnPublisher } from "../service.js";

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

    const turn: InboundTurn = {
      platform: "slack",
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

    await this.router.handleTurn(turn, new SlackPublisher(envelope));
  }
}

class SlackPublisher implements TurnPublisher {
  private statusMessageTs?: string;
  private processingStatus?: ProcessingStatus;

  constructor(private readonly envelope: SlackEnvelope) {}

  async publishQueued(): Promise<void> {
    await this.syncProcessingStatus("queued");
    if (this.envelope.postEphemeral) {
      await this.envelope.postEphemeral("Queued behind the active Codex turn for this thread.");
      return;
    }

    await this.setStatusMessage("Queued", "Queued behind the active Codex turn for this thread.");
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
    await this.setMessage(message);
  }

  async publishCompleted(_: InboundTurn, message: OutboundMessage): Promise<void> {
    await this.syncProcessingStatus("finished");
    const suffix = message.truncated ? "\n\nReply was truncated for chat delivery." : "";
    await this.envelope.postMessage(`${message.text}${suffix}`);
  }

  async publishInterrupted(_: InboundTurn, message: string): Promise<void> {
    await this.syncProcessingStatus("interrupted");
    await this.setStatusMessage("Interrupted", message);
  }

  async publishFailed(_: InboundTurn, errorMessage: string): Promise<void> {
    await this.syncProcessingStatus("failed");
    if (this.statusMessageTs && this.envelope.updateMessage) {
      await this.envelope.updateMessage(
        this.statusMessageTs,
        renderSlackStatus("Failed", "Codex could not complete this turn.")
      );
    }

    await this.envelope.postMessage(renderSlackError(errorMessage));
  }

  private async syncProcessingStatus(status: ProcessingStatus): Promise<void> {
    if (!this.envelope.syncStatusReaction || this.processingStatus === status) {
      return;
    }

    try {
      await this.envelope.syncStatusReaction(status);
      this.processingStatus = status;
    } catch {
      // Reaction failures should not abort the Slack turn.
    }
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

function renderSlackError(errorMessage: string): string {
  return [
    "*Codex failed*",
    "```",
    trimCodeFencePayload(errorMessage),
    "```"
  ].join("\n");
}

function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
}
