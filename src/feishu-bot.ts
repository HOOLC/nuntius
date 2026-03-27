import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as Lark from "@larksuiteoapi/node-sdk";

import {
  FeishuAdapter,
  renderFeishuNotice,
  renderFeishuTextMessage,
  type FeishuChatMessage,
  type FeishuEnvelope
} from "./adapters/feishu.js";
import {
  formatBridgeFailure,
  formatSessionReconciliationLines,
  logSessionReconciliation,
  runPackageScript
} from "./bot-runtime-utils.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import {
  detectConversationLanguage,
  localize,
  resolveConversationLanguage
} from "./conversation-language.js";
import type { BridgeCommand } from "./interaction-router.js";
import { parseBridgeCommand } from "./interaction-router.js";
import { loadFeishuBotConfig, type FeishuBotConfig } from "./feishu-config.js";
import type { Attachment, InboundTurn, ProcessingStatus } from "./domain.js";
import {
  isProcessGuardActive,
  PROCESS_RESTART_EXIT_CODE,
  runModuleWithRestartGuard
} from "./process-guard.js";
import { maybeRelaunchCurrentProcessPersistently } from "./persistent-launch.js";
import { trimCodeFencePayload } from "./text-formatting.js";
import {
  isSupervisorToWorkerMessage,
  resolveWorkerMode,
  sendWorkerMessage,
  sendWorkerMessageAndExit,
  type WorkerMode,
  type WorkerToSupervisorMessage
} from "./worker-supervisor-protocol.js";
import { ChildWorkerSupervisor } from "./worker-supervisor.js";

const EVENT_DEDUP_TTL_MS = 10 * 60_000;
const BUILD_OUTPUT_LINE_LIMIT = 40;
const BUILD_OUTPUT_CHAR_LIMIT = 3500;
const BRIDGE_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FEISHU_ATTACHMENT_ROOT = path.join(os.tmpdir(), "nuntius-feishu-attachments");
const FEISHU_MODULE_PATH = fileURLToPath(import.meta.url);

interface FeishuBotInfoResponse {
  code: number;
  msg: string;
  bot?: {
    open_id?: string;
  };
}

interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuMessageResponse {
  code: number;
  msg: string;
  error?: {
    log_id?: string;
  };
  data?: {
    message_id?: string;
    thread_id?: string;
  };
}

interface FeishuFileUploadResponse {
  code: number;
  msg: string;
  error?: {
    log_id?: string;
  };
  data?: {
    file_key?: string;
  };
}

interface FeishuUserId {
  open_id?: string;
  user_id?: string;
  union_id?: string;
}

interface FeishuMention {
  key?: string;
  id?: FeishuUserId | string;
  name?: string;
  tenant_key?: string;
}

interface FeishuMessageEventPayload {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  update_time?: string;
  chat_id: string;
  thread_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
}

interface FeishuMessageReceiveEvent {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender?: {
    sender_id?: FeishuUserId;
    sender_type?: string;
    tenant_key?: string;
  };
  message?: FeishuMessageEventPayload;
}

interface FeishuConversationTarget {
  workspaceId: string;
  channelId: string;
  threadId?: string;
  scope: "dm" | "channel" | "thread";
  replyMessageId?: string;
}

interface ParsedFeishuMessage {
  text: string;
  attachments: Attachment[];
  mentionedBot: boolean;
}

interface FlattenPostContext {
  botMentionKeys: Set<string>;
  mentionNames: Map<string, string>;
}

interface FeishuBotRuntime {
  isSupervisorAvailable?: () => boolean;
  rebuildBridge?: () => Promise<{
    ok: boolean;
    output: string;
  }>;
  sendWorkerMessage?: (message: WorkerToSupervisorMessage) => void;
}

export class FeishuBot {
  private readonly bridgeRuntime = createBridgeRuntime();
  private feishuConfig = loadFeishuBotConfig();
  private feishuApi = new FeishuApiClient(this.feishuConfig);
  private readonly adapter = new FeishuAdapter(this.bridgeRuntime.router);
  private readonly recentMessageIds = new Map<string, number>();
  private longConnection?: Lark.WSClient;
  private botOpenId?: string;

  constructor(private readonly runtime: FeishuBotRuntime = {}) {}

  async start(): Promise<void> {
    const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
    logSessionReconciliation("Feishu bot startup", sessionRefresh);
    await this.refreshFeishuClient();
    this.installSignalHandlers();
    await this.connectLongConnection();
    console.log("Feishu bot started in long connection mode.");
  }

  async stop(): Promise<void> {
    if (!this.longConnection) {
      return;
    }

    const activeConnection = this.longConnection;
    this.longConnection = undefined;
    activeConnection.close();
  }

  async refreshFeishuClient(): Promise<void> {
    this.feishuApi = new FeishuApiClient(this.feishuConfig);
    const botInfo = await this.feishuApi.getBotInfo();
    this.botOpenId = botInfo.openId;
  }

  private installSignalHandlers(): void {
    process.once("SIGINT", () => {
      void this.shutdownAndExit(0);
    });

    process.once("SIGTERM", () => {
      void this.shutdownAndExit(0);
    });
  }

  private async shutdownAndExit(exitCode: number): Promise<void> {
    try {
      await this.stop();
    } finally {
      process.exit(exitCode);
    }
  }

  private async connectLongConnection(): Promise<void> {
    const previousConnection = this.longConnection;
    this.longConnection = undefined;
    previousConnection?.close();

    const wsClient = new Lark.WSClient({
      appId: this.feishuConfig.appId,
      appSecret: this.feishuConfig.appSecret,
      domain: buildFeishuSdkDomain(this.feishuConfig.apiBaseUrl),
      loggerLevel: Lark.LoggerLevel.warn
    });

    this.longConnection = wsClient;
    await wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({
        loggerLevel: Lark.LoggerLevel.warn
      }).register({
        "im.message.receive_v1": (payload: FeishuMessageReceiveEvent) => {
          this.handleIncomingLongConnectionEvent(payload);
        }
      })
    });
  }

  private handleIncomingLongConnectionEvent(payload: FeishuMessageReceiveEvent): void {
    const messageId = payload.message?.message_id;
    if (!messageId || this.isDuplicateMessage(messageId)) {
      return;
    }

    void this.handleMessageEvent(payload).catch((error) => {
      console.error(formatBridgeFailure("Feishu", error));
    });
  }

  private async handleMessageEvent(payload: FeishuMessageReceiveEvent): Promise<void> {
    const workspaceId = payload.tenant_key ?? payload.sender?.tenant_key ?? "unknown";
    const message = payload.message;
    const sender = payload.sender;

    if (!message || !sender || sender.sender_type !== "user") {
      return;
    }

    const userId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "unknown";
    if (!this.isAllowedUser(userId)) {
      return;
    }

    const target = buildBaseConversationTarget(workspaceId, message);
    const parsedMessage = parseFeishuMessage(message, this.botOpenId);
    const attachments = await this.materializeAttachments(message, parsedMessage.attachments);
    const receivedAt = feishuTimestampToIso(message.create_time);
    const trimmedText = parsedMessage.text.trim();

    if (trimmedText.startsWith("/codexadmin")) {
      await this.handleAdminMessage({
        workspaceId,
        target,
        userId,
        text: trimmedText
      });
      return;
    }

    if (target.scope === "dm") {
      await this.handleDmMessageEvent({
        target,
        userId,
        text: trimmedText,
        attachments,
        sourceMessageId: message.message_id,
        receivedAt
      });
      return;
    }

    if (target.scope === "thread") {
      await this.handleThreadMessageEvent({
        target,
        userId,
        text: trimmedText,
        attachments,
        mentionedBot: parsedMessage.mentionedBot,
        sourceMessageId: message.message_id,
        receivedAt
      });
      return;
    }

    await this.handleRootChannelMessageEvent({
      target,
      userId,
      text: trimmedText,
      attachments,
      mentionedBot: parsedMessage.mentionedBot,
      sourceMessageId: message.message_id,
      receivedAt
    });
  }

  private async handleDmMessageEvent(input: {
    target: FeishuConversationTarget;
    userId: string;
    text: string;
    attachments: Attachment[];
    sourceMessageId: string;
    receivedAt: string;
  }): Promise<void> {
    const language = resolveConversationLanguage({
      text: input.text
    });
    if (!input.text && input.attachments.length === 0) {
      await this.postConversationFailure(
        input.target,
        localize(language, {
          en: "Send a message for Codex or use `/codex help`.",
          zh: "请发送一条给 Codex 的消息，或使用 `/codex help`。"
        })
      );
      return;
    }

    await this.adapter.handleTurn(
      this.buildFeishuEnvelope({
        target: input.target,
        userId: input.userId,
        text: input.text,
        attachments: input.attachments,
        sourceMessageId: input.sourceMessageId,
        receivedAt: input.receivedAt
      })
    );
  }

  private async handleThreadMessageEvent(input: {
    target: FeishuConversationTarget;
    userId: string;
    text: string;
    attachments: Attachment[];
    mentionedBot: boolean;
    sourceMessageId: string;
    receivedAt: string;
  }): Promise<void> {
    const looksLikeCodexCommand = input.text.startsWith("/codex");
    const status = await this.bridgeRuntime.bridge.getConversationStatus(
      buildFeishuTurnSeed(input.target, input.userId)
    );
    const language = resolveConversationLanguage({
      binding: status.binding,
      text: input.text
    });

    if (!status.binding && !input.mentionedBot && !looksLikeCodexCommand) {
      return;
    }

    if (!input.text && input.attachments.length === 0) {
      await this.postConversationFailure(
        input.target,
        localize(language, {
          en: "Reply with a message for Codex or use `/codex help`.",
          zh: "请回复一条发给 Codex 的消息，或使用 `/codex help`。"
        })
      );
      return;
    }

    await this.adapter.handleTurn(
      this.buildFeishuEnvelope({
        target: input.target,
        userId: input.userId,
        text: input.text,
        attachments: input.attachments,
        sourceMessageId: input.sourceMessageId,
        receivedAt: input.receivedAt
      })
    );
  }

  private async handleRootChannelMessageEvent(input: {
    target: FeishuConversationTarget;
    userId: string;
    text: string;
    attachments: Attachment[];
    mentionedBot: boolean;
    sourceMessageId: string;
    receivedAt: string;
  }): Promise<void> {
    const looksLikeCodexCommand = input.text.startsWith("/codex");
    const language = resolveConversationLanguage({
      text: input.text
    });
    if (!looksLikeCodexCommand && !input.mentionedBot) {
      return;
    }

    if (looksLikeCodexCommand) {
      const command = parseBridgeCommand(input.text);

      if (!requiresPersistentConversation(command)) {
        await this.adapter.handleTurn(
          this.buildFeishuEnvelope({
            target: input.target,
            userId: input.userId,
            text: input.text,
            attachments: input.attachments,
            sourceMessageId: input.sourceMessageId,
            receivedAt: input.receivedAt
          })
        );
        return;
      }

      const threadTarget = await this.createThreadTarget(input.target, language);
      await this.adapter.handleTurn(
        this.buildFeishuEnvelope({
          target: threadTarget,
          userId: input.userId,
          text: input.text,
          attachments: input.attachments,
          sourceMessageId: input.sourceMessageId,
          receivedAt: input.receivedAt
        })
      );
      return;
    }

    if (!input.text && input.attachments.length === 0) {
      await this.postConversationFailure(
        input.target,
        localize(language, {
          en: "Mention me with a prompt, or use `/codex help` in the thread after I reply.",
          zh: "请在提及时附上你的请求，或等我回复后在该线程里使用 `/codex help`。"
        })
      );
      return;
    }

    const threadTarget = await this.createThreadTarget(input.target, language);
    await this.adapter.handleTurn(
      this.buildFeishuEnvelope({
        target: threadTarget,
        userId: input.userId,
        text: input.text,
        attachments: input.attachments,
        sourceMessageId: input.sourceMessageId,
        receivedAt: input.receivedAt
      })
    );
  }

  private async handleAdminMessage(input: {
    workspaceId: string;
    target: FeishuConversationTarget;
    userId: string;
    text: string;
  }): Promise<void> {
    if (!this.isAdminUser(input.userId)) {
      await this.postAdminMessage(input.target, "You are not allowed to use /codexadmin.");
      return;
    }

    const rest = input.text.slice("/codexadmin".length).trim();
    const [rawCommand = "help"] = rest.split(/\s+/);
    const command = rawCommand.toLowerCase();

    try {
      switch (command) {
        case "":
        case "help":
          await this.postAdminMessage(input.target, buildFeishuAdminHelp());
          return;
        case "status": {
          const snapshot = this.bridgeRuntime.getRepositoryRegistrySnapshot();
          await this.postAdminMessage(
            input.target,
            [
              "Codex admin status:",
              `- Config source: ${this.feishuConfig.configFilePath ?? "env"}`,
              `- Registry source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.feishuConfig.allowedOpenIds.length || "all"}`,
              `- Admin users configured: ${this.feishuConfig.adminOpenIds.length}`,
              "- Event delivery: long connection",
              `- Hot reload available: ${String(this.isSupervisorAvailable())}`,
              `- API base URL: ${this.feishuConfig.apiBaseUrl}`,
              `- Restart allowed: ${String(this.feishuConfig.allowProcessRestart)}`
            ].join("\n")
          );
          return;
        }
        case "reloadconfig": {
          const previousAppId = this.feishuConfig.appId;
          const previousAppSecret = this.feishuConfig.appSecret;
          const previousApiBaseUrl = this.feishuConfig.apiBaseUrl;

          const snapshot = this.bridgeRuntime.reloadRepositoryRegistry();
          const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
          this.feishuConfig = loadFeishuBotConfig();
          await this.refreshFeishuClient();
          await this.connectLongConnection();

          const notes: string[] = [];
          if (
            previousAppId !== this.feishuConfig.appId ||
            previousAppSecret !== this.feishuConfig.appSecret ||
            previousApiBaseUrl !== this.feishuConfig.apiBaseUrl
          ) {
            notes.push("Feishu long connection settings changed and the client was restarted.");
          }

          await this.postAdminMessage(
            input.target,
            [
              "Reloaded runtime config.",
              `- Config source: ${this.feishuConfig.configFilePath ?? "env"}`,
              `- Registry source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.feishuConfig.allowedOpenIds.length || "all"}`,
              `- Admin users configured: ${this.feishuConfig.adminOpenIds.length}`,
              "- Event delivery: long connection",
              ...formatSessionReconciliationLines(sessionRefresh),
              ...notes
            ].join("\n")
          );
          return;
        }
        case "hotreload": {
          await this.postAdminMessage(
            input.target,
            "Rebuilding the Feishu bridge now. If the build succeeds, I will request a hot reload next."
          );

          const buildResult = await this.rebuildBridge();
          if (!buildResult.ok) {
            await this.postAdminMessage(
              input.target,
              formatScriptFailure("Build", buildResult.output, "No build output was captured.")
            );
            return;
          }

          if (!this.isSupervisorAvailable()) {
            await this.postAdminMessage(
              input.target,
              [
                "Build succeeded, but hot reload is unavailable because the bot is not running under the bundled supervisor.",
                formatScriptSuccessSummary("Build output", buildResult.output, "Build completed successfully.")
              ].join("\n\n")
            );
            return;
          }

          await this.postAdminMessage(
            input.target,
            [
              "Build succeeded. Hot reload requested.",
              "Existing session bindings will be reconciled when the new worker starts.",
              formatScriptSuccessSummary("Build output", buildResult.output, "Build completed successfully.")
            ].join("\n\n")
          );
          this.sendWorkerMessage({
            type: "request_hot_reload"
          });
          return;
        }
        case "restart":
          if (!this.feishuConfig.allowProcessRestart) {
            await this.postAdminMessage(
              input.target,
              "Process restart is disabled. Set feishu.allow_process_restart=true in nuntius.toml to enable it."
            );
            return;
          }

          if (this.isSupervisorAvailable()) {
            await this.postAdminMessage(
              input.target,
              isProcessGuardActive()
                ? "Restart requested. The supervisor will exit now and the bundled guard will start a fresh process."
                : "Restart requested. The supervisor will exit now; start it again or use an external service manager."
            );
            this.sendWorkerMessage({
              type: "request_restart"
            });
            return;
          }

          await this.postAdminMessage(
            input.target,
            isProcessGuardActive()
              ? "Restart requested. The process will exit now and the bundled guard will start a fresh process."
              : "Restart requested. The process will exit now; an external supervisor must start it again."
          );
          setTimeout(() => {
            process.exit(PROCESS_RESTART_EXIT_CODE);
          }, 250);
          return;
        default:
          await this.postAdminMessage(
            input.target,
            `Unsupported /codexadmin command "${command}".\n${buildFeishuAdminHelp()}`
          );
      }
    } catch (error) {
      await this.postAdminMessage(input.target, formatBridgeFailure("Feishu", error));
    }
  }

  private async createThreadTarget(
    target: FeishuConversationTarget,
    language: "en" | "zh"
  ): Promise<FeishuConversationTarget> {
    if (target.scope !== "channel" || !target.replyMessageId) {
      return target;
    }

    const starter = await this.feishuApi.replyMessage({
      messageId: target.replyMessageId,
      message: renderFeishuTextMessage(
        localize(language, {
          en: "Codex thread",
          zh: "Codex 线程"
        })
      ),
      replyInThread: true
    });

    if (!starter.threadId) {
      throw new Error("Feishu did not return a thread_id when creating the conversation thread.");
    }

    return {
      ...target,
      scope: "thread",
      threadId: starter.threadId
    };
  }

  private async materializeAttachments(
    message: FeishuMessageEventPayload,
    attachments: Attachment[]
  ): Promise<Attachment[]> {
    const resourceType = mapFeishuMessageResourceType(message.message_type);
    if (!resourceType || attachments.length === 0) {
      return attachments;
    }

    const attachmentDir = path.join(
      FEISHU_ATTACHMENT_ROOT,
      sanitizePathComponent(message.message_id)
    );
    await fs.mkdir(attachmentDir, {
      recursive: true
    });

    return Promise.all(
      attachments.map(async (attachment, index) => {
        const fileName = sanitizeAttachmentFileName(
          attachment.name ?? `${attachment.kind}-${index + 1}${inferAttachmentExtension(resourceType)}`
        );
        const localPath = path.join(attachmentDir, `${index + 1}-${fileName}`);
        const downloaded = await this.feishuApi.downloadMessageResource({
          messageId: message.message_id,
          fileKey: attachment.id,
          type: resourceType,
          destinationPath: localPath
        });

        return {
          ...attachment,
          localPath,
          mimeType: attachment.mimeType ?? downloaded.contentType ?? inferMimeTypeFromFilename(fileName)
        };
      })
    );
  }

  private buildFeishuEnvelope(input: {
    target: FeishuConversationTarget;
    userId: string;
    text: string;
    attachments?: Attachment[];
    sourceMessageId?: string;
    receivedAt?: string;
  }): FeishuEnvelope {
    const syncStatusReaction = input.sourceMessageId
      ? createFeishuStatusReactionSyncer(this.feishuApi, input.sourceMessageId)
      : undefined;

    return {
      workspaceId: input.target.workspaceId,
      channelId: input.target.channelId,
      threadId: input.target.threadId,
      scope: input.target.scope,
      userId: input.userId,
      text: input.text,
      attachments: input.attachments ?? [],
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      acknowledge: async () => undefined,
      postMessage: async (message) => this.postConversationMessage(input.target, message),
      updateMessage: async (messageId, message) => {
        await this.feishuApi.updateMessage({
          messageId,
          message
        });
      },
      uploadFile: async (upload) => {
        const fileKey = await this.feishuApi.uploadFile(upload);
        return {
          fileKey
        };
      },
      syncStatusReaction
    };
  }

  private async postConversationMessage(
    target: FeishuConversationTarget,
    message: FeishuChatMessage
  ): Promise<{ messageId?: string }> {
    if (target.scope === "thread" && target.replyMessageId) {
      const result = await this.feishuApi.replyMessage({
        messageId: target.replyMessageId,
        message,
        replyInThread: true
      });
      return {
        messageId: result.messageId
      };
    }

    if (target.replyMessageId) {
      const result = await this.feishuApi.replyMessage({
        messageId: target.replyMessageId,
        message,
        replyInThread: false
      });
      return {
        messageId: result.messageId
      };
    }

    const result = await this.feishuApi.sendMessage({
      receiveId: target.channelId,
      receiveIdType: "chat_id",
      message
    });
    return {
      messageId: result.messageId
    };
  }

  private async postConversationNotice(
    target: FeishuConversationTarget,
    title: string,
    body: string
  ): Promise<void> {
    await this.postConversationMessage(target, renderFeishuNotice(title, body));
  }

  private async postAdminMessage(
    target: FeishuConversationTarget,
    body: string
  ): Promise<void> {
    await this.postConversationNotice(target, "Codex Admin", body);
  }

  private async postConversationFailure(
    target: FeishuConversationTarget,
    message: string
  ): Promise<void> {
    await this.postConversationNotice(target, "Codex", message);
  }

  private isSupervisorAvailable(): boolean {
    return this.runtime.isSupervisorAvailable?.() ?? typeof process.send === "function";
  }

  private async rebuildBridge(): Promise<{
    ok: boolean;
    output: string;
  }> {
    return this.runtime.rebuildBridge?.() ?? rebuildFeishuBridge();
  }

  private sendWorkerMessage(message: WorkerToSupervisorMessage): void {
    if (this.runtime.sendWorkerMessage) {
      this.runtime.sendWorkerMessage(message);
      return;
    }

    sendWorkerMessage(message);
  }

  private isAllowedUser(userId: string): boolean {
    if (this.feishuConfig.allowedOpenIds.length === 0) {
      return true;
    }

    return this.feishuConfig.allowedOpenIds.includes(userId);
  }

  private isAdminUser(userId: string): boolean {
    return this.feishuConfig.adminOpenIds.includes(userId);
  }

  private isDuplicateMessage(messageId: string): boolean {
    const now = Date.now();

    for (const [existingMessageId, seenAt] of this.recentMessageIds.entries()) {
      if (now - seenAt > EVENT_DEDUP_TTL_MS) {
        this.recentMessageIds.delete(existingMessageId);
      }
    }

    if (this.recentMessageIds.has(messageId)) {
      return true;
    }

    this.recentMessageIds.set(messageId, now);
    return false;
  }
}

class FeishuApiClient {
  private accessToken?: {
    value: string;
    expiresAt: number;
  };
  private inflightToken?: Promise<string>;

  constructor(private readonly config: FeishuBotConfig) {}

  async getBotInfo(): Promise<{ openId?: string }> {
    const response = await this.callApi<FeishuBotInfoResponse>("GET", "/bot/v3/info");
    return {
      openId: response.bot?.open_id
    };
  }

  async sendMessage(input: {
    receiveId: string;
    receiveIdType: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
    message: FeishuChatMessage;
  }): Promise<{ messageId?: string; threadId?: string }> {
    const response = await this.callApi<FeishuMessageResponse>(
      "POST",
      `/im/v1/messages?receive_id_type=${encodeURIComponent(input.receiveIdType)}`,
      {
        receive_id: input.receiveId,
        msg_type: input.message.msgType,
        content: input.message.content,
        uuid: randomUuid()
      }
    );

    return {
      messageId: response.data?.message_id,
      threadId: response.data?.thread_id
    };
  }

  async replyMessage(input: {
    messageId: string;
    message: FeishuChatMessage;
    replyInThread: boolean;
  }): Promise<{ messageId?: string; threadId?: string }> {
    const response = await this.callApi<FeishuMessageResponse>(
      "POST",
      `/im/v1/messages/${encodeURIComponent(input.messageId)}/reply`,
      {
        msg_type: input.message.msgType,
        content: input.message.content,
        reply_in_thread: input.replyInThread,
        uuid: randomUuid()
      }
    );

    return {
      messageId: response.data?.message_id,
      threadId: response.data?.thread_id
    };
  }

  async updateMessage(input: {
    messageId: string;
    message: FeishuChatMessage;
  }): Promise<void> {
    await this.callApi<FeishuMessageResponse>(
      "PUT",
      `/im/v1/messages/${encodeURIComponent(input.messageId)}`,
      {
        msg_type: input.message.msgType,
        content: input.message.content
      }
    );
  }

  async addMessageReaction(input: {
    messageId: string;
    emojiType: string;
  }): Promise<{ reactionId?: string }> {
    const response = await this.callApi<{
      code: number;
      msg: string;
      error?: {
        log_id?: string;
      };
      data?: {
        reaction_id?: string;
      };
    }>(
      "POST",
      `/im/v1/messages/${encodeURIComponent(input.messageId)}/reactions`,
      {
        reaction_type: {
          emoji_type: input.emojiType
        }
      }
    );

    return {
      reactionId: response.data?.reaction_id
    };
  }

  async deleteMessageReaction(input: {
    messageId: string;
    reactionId: string;
  }): Promise<void> {
    await this.callApi<{ code: number; msg: string; error?: { log_id?: string } }>(
      "DELETE",
      `/im/v1/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(input.reactionId)}`
    );
  }

  async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    type: "audio" | "file" | "image" | "media";
    destinationPath: string;
  }): Promise<{ contentType?: string }> {
    const accessToken = await this.getTenantAccessToken();
    const resourceUrl = new URL(
      joinFeishuApiUrl(
        this.config.apiBaseUrl,
        `/im/v1/messages/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(input.fileKey)}`
      )
    );
    resourceUrl.searchParams.set("type", input.type);

    const response = await fetch(resourceUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Feishu API message resource download failed with HTTP ${response.status}.`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(input.destinationPath, body);
    return {
      contentType: response.headers.get("content-type") ?? undefined
    };
  }

  async uploadFile(input: {
    localPath: string;
    name: string;
    mimeType?: string;
  }): Promise<string> {
    const accessToken = await this.getTenantAccessToken();
    const body = await fs.readFile(input.localPath);
    const form = new FormData();
    form.set("file_type", resolveFeishuUploadFileType(input.name));
    form.set("file_name", input.name);
    form.set(
      "file",
      new Blob([body], {
        type: input.mimeType ?? "application/octet-stream"
      }),
      input.name
    );

    const response = await fetch(joinFeishuApiUrl(this.config.apiBaseUrl, "/im/v1/files"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      body: form
    });

    if (!response.ok) {
      throw new Error(`Feishu API /im/v1/files failed with HTTP ${response.status}.`);
    }

    const parsed = (await response.json()) as FeishuFileUploadResponse;
    if (parsed.code !== 0 || !parsed.data?.file_key) {
      const logId = parsed.error?.log_id ? ` log_id=${parsed.error.log_id}` : "";
      throw new Error(`Feishu API /im/v1/files failed: ${parsed.msg}.${logId}`);
    }

    return parsed.data.file_key;
  }

  private async callApi<T extends { code: number; msg: string; error?: { log_id?: string } }>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    resourcePath: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const accessToken = await this.getTenantAccessToken();
    const response = await fetch(joinFeishuApiUrl(this.config.apiBaseUrl, resourcePath), {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      throw new Error(`Feishu API ${resourcePath} failed with HTTP ${response.status}.`);
    }

    const parsed = (await response.json()) as T;
    if (parsed.code !== 0) {
      const logId = parsed.error?.log_id ? ` log_id=${parsed.error.log_id}` : "";
      throw new Error(`Feishu API ${resourcePath} failed: ${parsed.msg}.${logId}`);
    }

    return parsed;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) {
      return this.accessToken.value;
    }

    if (this.inflightToken) {
      return this.inflightToken;
    }

    this.inflightToken = this.fetchTenantAccessToken();

    try {
      return await this.inflightToken;
    } finally {
      this.inflightToken = undefined;
    }
  }

  private async fetchTenantAccessToken(): Promise<string> {
    const response = await fetch(joinFeishuApiUrl(this.config.apiBaseUrl, "/auth/v3/tenant_access_token/internal"), {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret
      })
    });

    if (!response.ok) {
      throw new Error(`Feishu auth failed with HTTP ${response.status}.`);
    }

    const parsed = (await response.json()) as FeishuTokenResponse;
    if (parsed.code !== 0 || !parsed.tenant_access_token || !parsed.expire) {
      throw new Error(`Feishu auth failed: ${parsed.msg}.`);
    }

    this.accessToken = {
      value: parsed.tenant_access_token,
      expiresAt: Date.now() + parsed.expire * 1000 - 60_000
    };

    return parsed.tenant_access_token;
  }
}

function createFeishuStatusReactionSyncer(
  feishuApi: FeishuApiClient,
  messageId: string
): (status: ProcessingStatus) => Promise<void> {
  let currentStatus: ProcessingStatus | undefined;
  let currentReactionId: string | undefined;

  return async (status) => {
    if (currentStatus === status) {
      return;
    }

    if (currentReactionId) {
      try {
        await feishuApi.deleteMessageReaction({
          messageId,
          reactionId: currentReactionId
        });
      } catch {
        // Best-effort cleanup of the previous processing marker.
      }
    }

    const created = await feishuApi.addMessageReaction({
      messageId,
      emojiType: feishuProcessingEmojiType(status)
    });
    currentReactionId = created.reactionId;
    currentStatus = status;
  };
}

function feishuProcessingEmojiType(status: ProcessingStatus): string {
  switch (status) {
    case "queued":
      return "OneSecond";
    case "working":
      return "HAMMER";
    case "finished":
      return "DONE";
    case "failed":
      return "CrossMark";
    case "interrupted":
      return "Alarm";
  }
}

function buildBaseConversationTarget(
  workspaceId: string,
  message: FeishuMessageEventPayload
): FeishuConversationTarget {
  if (message.chat_type === "p2p") {
    return {
      workspaceId,
      channelId: message.chat_id,
      scope: "dm",
      replyMessageId: message.message_id
    };
  }

  if (message.thread_id) {
    return {
      workspaceId,
      channelId: message.chat_id,
      threadId: message.thread_id,
      scope: "thread",
      replyMessageId: message.root_id ?? message.message_id
    };
  }

  return {
    workspaceId,
    channelId: message.chat_id,
    scope: "channel",
    replyMessageId: message.message_id
  };
}

function parseFeishuMessage(
  message: FeishuMessageEventPayload,
  botOpenId: string | undefined
): ParsedFeishuMessage {
  const parsedContent = safeParseJson(message.content);
  const mentionNames = new Map<string, string>();
  const botMentionKeys = new Set<string>();

  for (const mention of message.mentions ?? []) {
    if (!mention.key) {
      continue;
    }

    mentionNames.set(mention.key, mention.name ?? mention.key);
    if (extractMentionOpenId(mention.id) === botOpenId) {
      botMentionKeys.add(mention.key);
    }
  }

  switch (message.message_type) {
    case "text":
      return {
        text: normalizeTextContent(readOptionalStringField(parsedContent, "text"), botMentionKeys, mentionNames),
        attachments: [],
        mentionedBot: botMentionKeys.size > 0
      };
    case "post":
      return {
        text: flattenPostContent(parsedContent, {
          botMentionKeys,
          mentionNames
        }),
        attachments: [],
        mentionedBot: botMentionKeys.size > 0
      };
    case "image":
      return {
        text: "",
        attachments: buildSingleAttachment(parsedContent, {
          idKey: "image_key",
          kind: "image"
        }),
        mentionedBot: botMentionKeys.size > 0
      };
    case "file":
    case "folder":
      return {
        text: "",
        attachments: buildSingleAttachment(parsedContent, {
          idKey: "file_key",
          kind: "file",
          nameKey: "file_name"
        }),
        mentionedBot: botMentionKeys.size > 0
      };
    case "audio":
    case "media":
      return {
        text: "",
        attachments: buildSingleAttachment(parsedContent, {
          idKey: "file_key",
          kind: "file",
          nameKey: "file_name"
        }),
        mentionedBot: botMentionKeys.size > 0
      };
    default:
      return {
        text: "",
        attachments: [],
        mentionedBot: botMentionKeys.size > 0
      };
  }
}

function buildSingleAttachment(
  content: unknown,
  options: {
    idKey: string;
    kind: Attachment["kind"];
    nameKey?: string;
  }
): Attachment[] {
  if (!isRecord(content) || typeof content[options.idKey] !== "string") {
    return [];
  }

  return [
    {
      id: content[options.idKey],
      kind: options.kind,
      name:
        options.nameKey && typeof content[options.nameKey] === "string"
          ? content[options.nameKey]
          : undefined
    }
  ];
}

function normalizeTextContent(
  text: string | undefined,
  botMentionKeys: Set<string>,
  mentionNames: Map<string, string>
): string {
  if (!text) {
    return "";
  }

  let normalized = text;
  for (const botMentionKey of botMentionKeys) {
    normalized = normalized.replaceAll(botMentionKey, " ");
  }

  for (const [key, name] of mentionNames.entries()) {
    if (botMentionKeys.has(key)) {
      continue;
    }

    normalized = normalized.replaceAll(key, `@${name}`);
  }

  return collapseWhitespace(normalized);
}

function flattenPostContent(content: unknown, context: FlattenPostContext): string {
  if (!isRecord(content) || !Array.isArray(content.content)) {
    return "";
  }

  const lines: string[] = [];

  for (const row of content.content) {
    if (!Array.isArray(row)) {
      continue;
    }

    const parts: string[] = [];
    for (const node of row) {
      if (!isRecord(node) || typeof node.tag !== "string") {
        continue;
      }

      switch (node.tag) {
        case "text":
          if (typeof node.text === "string") {
            parts.push(node.text);
          }
          break;
        case "a":
          if (typeof node.text === "string" && typeof node.href === "string") {
            parts.push(`${node.text} (${node.href})`);
          } else if (typeof node.text === "string") {
            parts.push(node.text);
          }
          break;
        case "at": {
          const key = typeof node.user_id === "string" ? node.user_id : undefined;
          if (!key || context.botMentionKeys.has(key)) {
            break;
          }

          parts.push(`@${context.mentionNames.get(key) ?? node.user_name ?? key}`);
          break;
        }
        case "code_block":
          if (typeof node.text === "string") {
            parts.push(node.text);
          }
          break;
        case "hr":
          parts.push("---");
          break;
      }
    }

    const line = collapseWhitespace(parts.join(" "));
    if (line) {
      lines.push(line);
    }
  }

  return lines.join("\n").trim();
}

function safeParseJson(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readOptionalStringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record) || typeof record[key] !== "string") {
    return undefined;
  }

  return record[key];
}

function extractMentionOpenId(value: FeishuUserId | string | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!value) {
    return undefined;
  }

  return value.open_id ?? value.user_id ?? value.union_id;
}

function collapseWhitespace(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function requiresPersistentConversation(command: BridgeCommand): boolean {
  return command.kind === "conversation" || command.kind === "bind";
}

function feishuTimestampToIso(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return new Date().toISOString();
  }

  return new Date(numeric).toISOString();
}

function buildFeishuTurnSeed(target: FeishuConversationTarget, userId: string): InboundTurn {
  return {
    platform: "feishu",
    workspaceId: target.workspaceId,
    channelId: target.channelId,
    threadId: target.threadId,
    scope: target.scope,
    userId,
    text: "",
    attachments: [],
    receivedAt: new Date().toISOString()
  };
}

function joinFeishuApiUrl(baseUrl: string, resourcePath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${resourcePath.replace(/^\/+/, "")}`;
}

function buildFeishuSdkDomain(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).origin;
}

function randomUuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function mapFeishuMessageResourceType(
  messageType: string | undefined
): "audio" | "file" | "image" | "media" | undefined {
  if (messageType === "audio" || messageType === "file" || messageType === "image" || messageType === "media") {
    return messageType;
  }

  return undefined;
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function sanitizeAttachmentFileName(value: string): string {
  const trimmed = path.basename(value).trim();
  if (!trimmed) {
    return "attachment.bin";
  }

  return trimmed.replace(/[^A-Za-z0-9._ -]+/g, "_");
}

function inferAttachmentExtension(resourceType: "audio" | "file" | "image" | "media"): string {
  switch (resourceType) {
    case "audio":
      return ".opus";
    case "image":
      return ".png";
    case "media":
      return ".mp4";
    case "file":
      return ".bin";
  }
}

function inferMimeTypeFromFilename(fileName: string): string | undefined {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

function resolveFeishuUploadFileType(fileName: string): "doc" | "pdf" | "ppt" | "stream" | "xls" {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".doc":
      return "doc";
    case ".pdf":
      return "pdf";
    case ".ppt":
    case ".pptx":
      return "ppt";
    case ".xls":
    case ".xlsx":
      return "xls";
    default:
      return "stream";
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function buildFeishuAdminHelp(): string {
  return [
    "Available admin commands:",
    "- `/codexadmin status`",
    "- `/codexadmin reloadconfig`",
    "- `/codexadmin hotreload`",
    "- `/codexadmin restart`",
    "- `/codexadmin help`"
  ].join("\n");
}

async function rebuildFeishuBridge(): Promise<{
  ok: boolean;
  output: string;
}> {
  return runPackageScript({
    cwd: BRIDGE_PROJECT_ROOT,
    scriptName: "build",
    maxOutputLines: BUILD_OUTPUT_LINE_LIMIT,
    maxOutputChars: BUILD_OUTPUT_CHAR_LIMIT
  });
}

function formatScriptFailure(label: string, output: string, fallback: string): string {
  return [
    `[${label} failed]`,
    trimCodeFencePayload(output || fallback)
  ].join("\n");
}

function formatScriptSuccessSummary(label: string, output: string, fallback: string): string {
  return [
    `${label}:`,
    trimCodeFencePayload(output || fallback)
  ].join("\n");
}

function installSupervisorMessageHandler(bot: FeishuBot): void {
  process.on("message", (message) => {
    if (!isSupervisorToWorkerMessage(message)) {
      return;
    }

    if (message.type === "shutdown") {
      void bot.stop().finally(() => {
        process.exit(0);
      });
    }
  });
}

async function startFeishuWorker(mode: WorkerMode): Promise<void> {
  const bot = new FeishuBot();

  if (mode === "probe") {
    await sendWorkerMessageAndExit({
      type: "probe_ready"
    });
    return;
  }

  installSupervisorMessageHandler(bot);
  await bot.start();
  sendWorkerMessage({
    type: "ready"
  });
}

async function runFeishuProcess(): Promise<void> {
  const workerMode = resolveWorkerMode(process.env.NUNTIUS_FEISHU_WORKER_MODE);
  if (workerMode) {
    await startFeishuWorker(workerMode);
    return;
  }

  const supervisor = new ChildWorkerSupervisor({
    serviceLabel: "Feishu",
    workerModulePath: fileURLToPath(import.meta.url),
    workerModeEnvKey: "NUNTIUS_FEISHU_WORKER_MODE",
    restartExitCode: PROCESS_RESTART_EXIT_CODE
  });
  await supervisor.start();
}

export async function main(): Promise<void> {
  if (await maybeRelaunchCurrentProcessPersistently({ label: "Feishu bot" })) {
    return;
  }

  if (!resolveWorkerMode(process.env.NUNTIUS_FEISHU_WORKER_MODE) && !isProcessGuardActive()) {
    await runModuleWithRestartGuard({
      label: "Feishu bot",
      modulePath: FEISHU_MODULE_PATH
    });
    return;
  }

  await runFeishuProcess();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
