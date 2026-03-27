import type { Attachment, InboundTurn, ProcessingStatus } from "../domain.js";

export interface AdapterEnvelope {
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
}

export function buildInboundTurn(
  platform: InboundTurn["platform"],
  envelope: AdapterEnvelope
): InboundTurn {
  return {
    platform,
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
}

export function createProcessingStatusSynchronizer(
  syncStatusReaction: ((status: ProcessingStatus) => Promise<void>) | undefined
): (status: ProcessingStatus) => Promise<void> {
  let currentStatus: ProcessingStatus | undefined;

  return async (status: ProcessingStatus): Promise<void> => {
    if (!syncStatusReaction || currentStatus === status) {
      return;
    }

    try {
      await syncStatusReaction(status);
      currentStatus = status;
    } catch {
      // Status sync failures should not abort delivery.
    }
  };
}
