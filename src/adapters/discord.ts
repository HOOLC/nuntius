import type {
  Attachment,
  ConversationBinding,
  InboundTurn,
  OutboundMessage
} from "../domain.js";
import {
  buildCodexNetworkAccessStartNote
} from "../codex-network-access.js";
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
}

export class DiscordAdapter {
  constructor(private readonly router: InteractionRouter) {}

  async handleTurn(envelope: DiscordEnvelope): Promise<void> {
    await envelope.deferReply();
    const typingLease = await envelope.startTyping?.();

    try {
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
    } finally {
      await typingLease?.stop();
    }
  }
}

class DiscordPublisher implements TurnPublisher {
  constructor(private readonly envelope: DiscordEnvelope) {}

  async publishQueued(): Promise<void> {
    await this.envelope.followUp(
      renderDiscordStatus("Queued", "Waiting for the active Codex turn in this conversation.")
    );
  }

  async publishStarted(
    _: InboundTurn,
    binding: ConversationBinding,
    note?: string
  ): Promise<void> {
    const activeRepository = binding.activeRepository;
    const details = activeRepository
      ? [
          note,
          `Repository: \`${activeRepository.repositoryId}\``,
          `Sandbox: \`${activeRepository.sandboxMode}\``,
          buildCodexNetworkAccessStartNote(activeRepository),
          activeRepository.workerSessionId
            ? `Worker session: \`${activeRepository.workerSessionId}\``
            : undefined
        ]
      : [note ?? "Running the handler Codex session."];

    await this.envelope.followUp(
      renderDiscordStatus("Started", details.filter(Boolean).join("\n"))
    );
  }

  async publishProgress(_: InboundTurn, message: string): Promise<void> {
    await this.envelope.followUp(renderDiscordStatus("Working", message));
  }

  async publishCompleted(_: InboundTurn, message: OutboundMessage): Promise<void> {
    const suffix = message.truncated ? "\n\n_Reply truncated for Discord delivery._" : "";
    await this.envelope.followUp(renderDiscordReply(`${message.text}${suffix}`));
  }

  async publishFailed(_: InboundTurn, errorMessage: string): Promise<void> {
    await this.envelope.followUp(renderDiscordError(errorMessage));
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

function renderDiscordError(errorMessage: string): string {
  return [
    "**Codex failed**",
    "```text",
    trimCodeFencePayload(errorMessage),
    "```"
  ].join("\n");
}

function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
}
