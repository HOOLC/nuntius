import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { FeishuAdapter, type FeishuEnvelope } from "./adapters/feishu.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import type { BridgeCommand } from "./interaction-router.js";
import { parseBridgeCommand } from "./interaction-router.js";
import { loadFeishuBotConfig, type FeishuBotConfig } from "./feishu-config.js";
import type { Attachment, InboundTurn } from "./domain.js";

const EVENT_DEDUP_TTL_MS = 10 * 60_000;

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

interface FeishuVerificationPayload {
  challenge: string;
  token?: string;
  type: "url_verification";
}

interface FeishuEventHeader {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  token?: string;
  app_id?: string;
  tenant_key?: string;
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
  chat_type?: "p2p" | "group";
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
}

interface FeishuMessageReceiveEvent {
  sender?: {
    sender_id?: FeishuUserId;
    sender_type?: string;
    tenant_key?: string;
  };
  message?: FeishuMessageEventPayload;
}

interface FeishuEventEnvelope {
  schema?: string;
  header?: FeishuEventHeader;
  token?: string;
  event?: FeishuMessageReceiveEvent;
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

export class FeishuBot {
  private readonly bridgeRuntime = createBridgeRuntime();
  private feishuConfig = loadFeishuBotConfig();
  private feishuApi = new FeishuApiClient(this.feishuConfig);
  private readonly adapter = new FeishuAdapter(this.bridgeRuntime.router);
  private readonly recentMessageIds = new Map<string, number>();
  private server?: Server;
  private botOpenId?: string;

  async start(): Promise<void> {
    const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
    logSessionReconciliation("Feishu bot startup", sessionRefresh);
    await this.refreshFeishuClient();
    this.installSignalHandlers();

    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.feishuConfig.port, this.feishuConfig.host, () => {
        resolve();
      });
    });

    console.log(
      `Feishu bot listening on http://${this.feishuConfig.host}:${this.feishuConfig.port}${this.feishuConfig.eventsPath}.`
    );
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const activeServer = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
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

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");

      if (method === "GET" && url.pathname === this.feishuConfig.healthPath) {
        respondText(response, 200, "ok");
        return;
      }

      if (method !== "POST" || url.pathname !== this.feishuConfig.eventsPath) {
        respondText(response, 404, "Not found");
        return;
      }

      const rawBody = await readRawBody(request);
      await this.handleEventRequest(rawBody, response, request.headers);
    } catch (error) {
      console.error(formatTopLevelError(error));

      if (!response.headersSent) {
        respondText(response, 500, "Feishu bridge failure");
      } else {
        response.end();
      }
    }
  }

  private async handleEventRequest(
    rawBody: Buffer,
    response: ServerResponse,
    headers: IncomingHttpHeaders = {}
  ): Promise<void> {
    const payload = this.parseEventRequest(rawBody, headers);

    if (isUrlVerificationPayload(payload)) {
      respondJson(response, 200, {
        challenge: payload.challenge
      });
      return;
    }

    if (!isMessageReceiveEnvelope(payload)) {
      respondText(response, 200, "ok");
      return;
    }

    const message = payload.event?.message;
    if (!message?.message_id || this.isDuplicateMessage(message.message_id)) {
      respondText(response, 200, "ok");
      return;
    }

    respondText(response, 200, "ok");
    await this.handleMessageEvent(payload);
  }

  private parseEventRequest(rawBody: Buffer, headers: IncomingHttpHeaders): unknown {
    const outer = JSON.parse(rawBody.toString("utf8")) as unknown;
    let payload = outer;

    if (
      this.feishuConfig.encryptKey &&
      isRecord(outer) &&
      typeof outer.encrypt === "string"
    ) {
      payload = JSON.parse(decryptFeishuEvent(outer.encrypt, this.feishuConfig.encryptKey)) as unknown;
    }

    if (!isUrlVerificationPayload(payload) && this.feishuConfig.encryptKey) {
      verifyFeishuSignature(headers, rawBody, this.feishuConfig.encryptKey);
    }

    verifyFeishuToken(payload, this.feishuConfig.verificationToken);
    return payload;
  }

  private async handleMessageEvent(payload: FeishuEventEnvelope): Promise<void> {
    const workspaceId = payload.header?.tenant_key ?? payload.event?.sender?.tenant_key ?? "unknown";
    const event = payload.event;
    const message = event?.message;
    const sender = event?.sender;

    if (!message || !sender || sender.sender_type !== "user") {
      return;
    }

    const userId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "unknown";
    if (!this.isAllowedUser(userId)) {
      return;
    }

    const target = buildBaseConversationTarget(workspaceId, message);
    const parsedMessage = parseFeishuMessage(message, this.botOpenId);
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
        attachments: parsedMessage.attachments,
        receivedAt
      });
      return;
    }

    if (target.scope === "thread") {
      await this.handleThreadMessageEvent({
        target,
        userId,
        text: trimmedText,
        attachments: parsedMessage.attachments,
        mentionedBot: parsedMessage.mentionedBot,
        receivedAt
      });
      return;
    }

    await this.handleRootChannelMessageEvent({
      target,
      userId,
      text: trimmedText,
      attachments: parsedMessage.attachments,
      mentionedBot: parsedMessage.mentionedBot,
      receivedAt
    });
  }

  private async handleDmMessageEvent(input: {
    target: FeishuConversationTarget;
    userId: string;
    text: string;
    attachments: Attachment[];
    receivedAt: string;
  }): Promise<void> {
    if (!input.text && input.attachments.length === 0) {
      await this.postConversationFailure(input.target, "Send a message for Codex or use `/codex help`.");
      return;
    }

    await this.adapter.handleTurn(
      this.buildFeishuEnvelope({
        target: input.target,
        userId: input.userId,
        text: input.text,
        attachments: input.attachments,
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
    receivedAt: string;
  }): Promise<void> {
    const looksLikeCodexCommand = input.text.startsWith("/codex");
    const status = await this.bridgeRuntime.bridge.getConversationStatus(
      buildFeishuTurnSeed(input.target, input.userId)
    );

    if (!status.binding && !input.mentionedBot && !looksLikeCodexCommand) {
      return;
    }

    if (!input.text && input.attachments.length === 0) {
      await this.postConversationFailure(
        input.target,
        "Reply with a message for Codex or use `/codex help`."
      );
      return;
    }

    await this.adapter.handleTurn(
      this.buildFeishuEnvelope({
        target: input.target,
        userId: input.userId,
        text: input.text,
        attachments: input.attachments,
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
    receivedAt: string;
  }): Promise<void> {
    const looksLikeCodexCommand = input.text.startsWith("/codex");
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
            receivedAt: input.receivedAt
          })
        );
        return;
      }

      const threadTarget = await this.createThreadTarget(input.target);
      await this.adapter.handleTurn(
        this.buildFeishuEnvelope({
          target: threadTarget,
          userId: input.userId,
          text: input.text,
          attachments: input.attachments,
          receivedAt: input.receivedAt
        })
      );
      return;
    }

    if (!input.text && input.attachments.length === 0) {
      await this.postConversationFailure(
        input.target,
        "Mention me with a prompt, or use `/codex help` in the thread after I reply."
      );
      return;
    }

    const threadTarget = await this.createThreadTarget(input.target);
    await this.adapter.handleTurn(
      this.buildFeishuEnvelope({
        target: threadTarget,
        userId: input.userId,
        text: input.text,
        attachments: input.attachments,
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
      await this.postConversationMessage(input.target, "You are not allowed to use /codexadmin.");
      return;
    }

    const rest = input.text.slice("/codexadmin".length).trim();
    const [rawCommand = "help"] = rest.split(/\s+/);
    const command = rawCommand.toLowerCase();

    try {
      switch (command) {
        case "":
        case "help":
          await this.postConversationMessage(input.target, buildFeishuAdminHelp());
          return;
        case "status": {
          const snapshot = this.bridgeRuntime.getRepositoryRegistrySnapshot();
          await this.postConversationMessage(
            input.target,
            [
              "Codex admin status:",
              `- Config source: ${this.feishuConfig.configFilePath ?? "env"}`,
              `- Registry source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.feishuConfig.allowedOpenIds.length || "all"}`,
              `- Admin users configured: ${this.feishuConfig.adminOpenIds.length}`,
              `- Listening on: ${this.feishuConfig.host}:${this.feishuConfig.port}`,
              `- Events path: ${this.feishuConfig.eventsPath}`,
              `- Restart allowed: ${String(this.feishuConfig.allowProcessRestart)}`
            ].join("\n")
          );
          return;
        }
        case "reloadconfig": {
          const previousHost = this.feishuConfig.host;
          const previousPort = this.feishuConfig.port;
          const previousEventsPath = this.feishuConfig.eventsPath;

          const snapshot = this.bridgeRuntime.reloadRepositoryRegistry();
          const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
          this.feishuConfig = loadFeishuBotConfig();
          await this.refreshFeishuClient();

          const notes: string[] = [];
          if (
            previousHost !== this.feishuConfig.host ||
            previousPort !== this.feishuConfig.port
          ) {
            notes.push("Listener host/port changes require a process restart.");
          }
          if (previousEventsPath !== this.feishuConfig.eventsPath) {
            notes.push("Update the Feishu callback URL if the events path changed.");
          }

          await this.postConversationMessage(
            input.target,
            [
              "Reloaded runtime config.",
              `- Config source: ${this.feishuConfig.configFilePath ?? "env"}`,
              `- Registry source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.feishuConfig.allowedOpenIds.length || "all"}`,
              `- Admin users configured: ${this.feishuConfig.adminOpenIds.length}`,
              ...formatSessionReconciliationLines(sessionRefresh),
              ...notes
            ].join("\n")
          );
          return;
        }
        case "restart":
          if (!this.feishuConfig.allowProcessRestart) {
            await this.postConversationMessage(
              input.target,
              "Process restart is disabled. Set feishu.allow_process_restart=true in nuntius.toml to enable it."
            );
            return;
          }

          await this.postConversationMessage(
            input.target,
            "Restart requested. The process will exit now; an external supervisor must start it again."
          );
          setTimeout(() => {
            process.exit(75);
          }, 250);
          return;
        default:
          await this.postConversationMessage(
            input.target,
            `Unsupported /codexadmin command "${command}".\n${buildFeishuAdminHelp()}`
          );
      }
    } catch (error) {
      await this.postConversationMessage(input.target, formatTopLevelError(error));
    }
  }

  private async createThreadTarget(target: FeishuConversationTarget): Promise<FeishuConversationTarget> {
    if (target.scope !== "channel" || !target.replyMessageId) {
      return target;
    }

    const starter = await this.feishuApi.replyMessage({
      messageId: target.replyMessageId,
      text: "Codex thread",
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

  private buildFeishuEnvelope(input: {
    target: FeishuConversationTarget;
    userId: string;
    text: string;
    attachments?: Attachment[];
    receivedAt?: string;
  }): FeishuEnvelope {
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
          text: message
        });
      }
    };
  }

  private async postConversationMessage(
    target: FeishuConversationTarget,
    message: string
  ): Promise<{ messageId?: string }> {
    if (target.scope === "thread" && target.replyMessageId) {
      const result = await this.feishuApi.replyMessage({
        messageId: target.replyMessageId,
        text: message,
        replyInThread: true
      });
      return {
        messageId: result.messageId
      };
    }

    if (target.replyMessageId) {
      const result = await this.feishuApi.replyMessage({
        messageId: target.replyMessageId,
        text: message,
        replyInThread: false
      });
      return {
        messageId: result.messageId
      };
    }

    const result = await this.feishuApi.sendMessage({
      receiveId: target.channelId,
      receiveIdType: "chat_id",
      text: message
    });
    return {
      messageId: result.messageId
    };
  }

  private async postConversationFailure(
    target: FeishuConversationTarget,
    message: string
  ): Promise<void> {
    await this.postConversationMessage(target, message);
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
    text: string;
  }): Promise<{ messageId?: string; threadId?: string }> {
    const response = await this.callApi<FeishuMessageResponse>(
      "POST",
      `/im/v1/messages?receive_id_type=${encodeURIComponent(input.receiveIdType)}`,
      {
        receive_id: input.receiveId,
        msg_type: "text",
        content: JSON.stringify({
          text: input.text
        }),
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
    text: string;
    replyInThread: boolean;
  }): Promise<{ messageId?: string; threadId?: string }> {
    const response = await this.callApi<FeishuMessageResponse>(
      "POST",
      `/im/v1/messages/${encodeURIComponent(input.messageId)}/reply`,
      {
        msg_type: "text",
        content: JSON.stringify({
          text: input.text
        }),
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
    text: string;
  }): Promise<void> {
    await this.callApi<FeishuMessageResponse>(
      "PUT",
      `/im/v1/messages/${encodeURIComponent(input.messageId)}`,
      {
        msg_type: "text",
        content: JSON.stringify({
          text: input.text
        })
      }
    );
  }

  private async callApi<T extends { code: number; msg: string; error?: { log_id?: string } }>(
    method: "GET" | "POST" | "PUT",
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

function isUrlVerificationPayload(value: unknown): value is FeishuVerificationPayload {
  return (
    isRecord(value) &&
    value.type === "url_verification" &&
    typeof value.challenge === "string"
  );
}

function isMessageReceiveEnvelope(value: unknown): value is FeishuEventEnvelope {
  return (
    isRecord(value) &&
    isRecord(value.header) &&
    value.header.event_type === "im.message.receive_v1"
  );
}

function verifyFeishuToken(value: unknown, verificationToken: string | undefined): void {
  if (!verificationToken) {
    return;
  }

  const token =
    (isRecord(value) && typeof value.token === "string" ? value.token : undefined) ??
    (isRecord(value) && isRecord(value.header) && typeof value.header.token === "string"
      ? value.header.token
      : undefined);

  if (token !== verificationToken) {
    throw new Error("Feishu verification token mismatch.");
  }
}

function verifyFeishuSignature(
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  encryptKey: string
): void {
  const timestamp = readSingleHeader(headers["x-lark-request-timestamp"]);
  const nonce = readSingleHeader(headers["x-lark-request-nonce"]);
  const signature = readSingleHeader(headers["x-lark-signature"]);

  if (!timestamp || !nonce || !signature) {
    throw new Error("Feishu signature headers are missing.");
  }

  const expected = createHash("sha256")
    .update(timestamp + nonce + encryptKey)
    .update(rawBody)
    .digest("hex");
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid Feishu signature.");
  }
}

function decryptFeishuEvent(encryptedPayload: string, encryptKey: string): string {
  const decoded = Buffer.from(encryptedPayload, "base64");
  if (decoded.length < 16) {
    throw new Error("Feishu encrypted payload is too short.");
  }

  const iv = decoded.subarray(0, 16);
  const ciphertext = decoded.subarray(16);
  const key = createHash("sha256").update(encryptKey).digest();
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString("utf8");
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

function randomUuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0];
  }

  return undefined;
}

function respondText(
  response: ServerResponse,
  statusCode: number,
  body: string
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function buildFeishuAdminHelp(): string {
  return [
    "Codex admin commands:",
    "/codexadmin status",
    "/codexadmin reloadconfig",
    "/codexadmin restart",
    "/codexadmin help"
  ].join("\n");
}

function formatTopLevelError(error: unknown): string {
  if (error instanceof Error) {
    return `Feishu bridge failure: ${error.message}`;
  }

  return "Feishu bridge failure: unknown error.";
}

function logSessionReconciliation(
  context: string,
  result: {
    totalBindings: number;
    updatedBindings: number;
    clearedHandlerSessions: number;
    clearedWorkerSessions: number;
    droppedRepositoryBindings: number;
  }
): void {
  console.log(
    `${context}: reconciled ${result.updatedBindings}/${result.totalBindings} persisted session bindings (cleared handler sessions=${result.clearedHandlerSessions}, cleared worker sessions=${result.clearedWorkerSessions}, dropped repository bindings=${result.droppedRepositoryBindings}).`
  );
}

function formatSessionReconciliationLines(result: {
  totalBindings: number;
  updatedBindings: number;
  clearedHandlerSessions: number;
  clearedWorkerSessions: number;
  droppedRepositoryBindings: number;
}): string[] {
  return [
    `- Session bindings refreshed: ${result.updatedBindings}/${result.totalBindings}`,
    `- Cleared handler sessions: ${result.clearedHandlerSessions}`,
    `- Cleared worker sessions: ${result.clearedWorkerSessions}`,
    `- Dropped repo bindings: ${result.droppedRepositoryBindings}`
  ];
}

export async function main(): Promise<void> {
  const bot = new FeishuBot();
  await bot.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
