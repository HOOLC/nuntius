import type {
  Attachment,
  ConversationBinding,
  InboundTurn,
  OutboundMessage
} from "../domain.js";
import { buildCodexNetworkAccessStartNote } from "../codex-network-access.js";
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

  constructor(private readonly envelope: SlackEnvelope) {}

  async publishQueued(): Promise<void> {
    if (this.envelope.postEphemeral) {
      await this.envelope.postEphemeral("Queued behind the active Codex turn for this thread.");
      return;
    }

    await this.setStatusMessage("Queued", "Queued behind the active Codex turn for this thread.");
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
          `Running worker Codex against \`${activeRepository.repositoryId}\` (${activeRepository.sandboxMode})${
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
    if (this.statusMessageTs && this.envelope.updateMessage) {
      await this.envelope.updateMessage(this.statusMessageTs, renderSlackStatus("Completed", "Finished this Codex turn."));
    }

    const suffix = message.truncated ? "\n\nReply was truncated for chat delivery." : "";
    await this.envelope.postMessage(`${message.text}${suffix}`);
  }

  async publishFailed(_: InboundTurn, errorMessage: string): Promise<void> {
    if (this.statusMessageTs && this.envelope.updateMessage) {
      await this.envelope.updateMessage(
        this.statusMessageTs,
        renderSlackStatus("Failed", "Codex could not complete this turn.")
      );
    }

    await this.envelope.postMessage(renderSlackError(errorMessage));
  }

  private async setStatusMessage(title: string, body: string): Promise<void> {
    const content = renderSlackStatus(title, body);

    if (this.statusMessageTs && this.envelope.updateMessage) {
      await this.envelope.updateMessage(this.statusMessageTs, content);
      return;
    }

    const result = await this.envelope.postMessage(content);
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
