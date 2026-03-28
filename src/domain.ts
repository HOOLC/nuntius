export type ChatPlatform = "slack" | "discord" | "feishu";
export type ConversationScope = "dm" | "channel" | "thread";
export type ConversationLanguage = "en" | "zh";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type ProcessingStatus = "queued" | "working" | "finished" | "failed" | "interrupted";

export interface Attachment {
  id: string;
  kind: "image" | "text" | "file" | "link";
  name?: string;
  mimeType?: string;
  url?: string;
  localPath?: string;
}

export interface InboundTurn {
  platform: ChatPlatform;
  workspaceId: string;
  channelId: string;
  threadId?: string;
  userId: string;
  userDisplayName?: string;
  scope: ConversationScope;
  text: string;
  attachments: Attachment[];
  repositoryId?: string;
  receivedAt: string;
}

export interface ConversationKey {
  platform: ChatPlatform;
  workspaceId: string;
  channelId: string;
  threadId?: string;
}

export interface RepositoryBinding {
  repositoryId: string;
  repositoryPath: string;
  boundByUserId?: string;
  sandboxMode: SandboxMode;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  codexConfigOverrides?: string[];
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
  workerSessionId?: string;
  pendingWakeRequest?: WorkerWakeRequest;
  updatedAt: string;
}

export interface WorkerWakeRequest {
  id: string;
  requestedAt: string;
  dueAt: string;
  durationMs: number;
}

export interface HandlerSessionBinding {
  workspacePath: string;
  sandboxMode: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  model?: string;
  sessionConfigVersion?: number;
}

export interface ConversationBinding {
  key: ConversationKey;
  language?: ConversationLanguage;
  handlerSessionId?: string;
  handlerConfig?: HandlerSessionBinding;
  activeRepository?: RepositoryBinding;
  attachments?: Attachment[];
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexTurnResult {
  sessionId?: string;
  responseText: string;
  rawEvents: CodexEvent[];
  stderrLines: string[];
}

export interface OutboundAttachment {
  name: string;
  localPath: string;
  mimeType?: string;
}

export interface OutboundMessage {
  text: string;
  sessionId?: string;
  truncated?: boolean;
  attachments?: OutboundAttachment[];
}

export function toConversationKey(turn: InboundTurn): ConversationKey {
  return {
    platform: turn.platform,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    threadId: turn.threadId
  };
}

export function conversationKeyToId(key: ConversationKey): string {
  return [
    key.platform,
    key.workspaceId,
    key.channelId,
    key.threadId ?? "root"
  ].join(":");
}
