import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SlackAdapter, type SlackEnvelope } from "./adapters/slack.js";
import {
  formatBridgeFailure,
  formatSessionReconciliationLines,
  logSessionReconciliation
} from "./bot-runtime-utils.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import {
  detectConversationLanguage,
  localize,
  resolveConversationLanguage
} from "./conversation-language.js";
import type { BridgeCommand } from "./interaction-router.js";
import { parseBridgeCommand } from "./interaction-router.js";
import {
  isProcessGuardActive,
  PROCESS_RESTART_EXIT_CODE,
  runModuleWithRestartGuard
} from "./process-guard.js";
import { maybeRelaunchCurrentProcessPersistently } from "./persistent-launch.js";
import { loadSlackBotConfig, type SlackBotConfig } from "./slack-config.js";
import type { Attachment, ProcessingStatus } from "./domain.js";

const SIGNATURE_MAX_AGE_SECONDS = 60 * 5;
const EVENT_DEDUP_TTL_MS = 10 * 60_000;
const SLACK_MODULE_PATH = fileURLToPath(import.meta.url);

interface SlackSlashCommandPayload {
  command: string;
  text: string;
  team_id: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  response_url?: string;
  thread_ts?: string;
  ssl_check?: string;
}

interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: SlackMessageEvent;
}

interface SlackMessageEvent {
  type: string;
  user?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  hidden?: boolean;
  files?: SlackFile[];
}

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
}

interface SlackConversationTarget {
  workspaceId: string;
  channelId: string;
  threadId?: string;
  scope: "dm" | "channel" | "thread";
}

interface SlackAuthTestResult {
  userId: string;
  teamId?: string;
}

interface SlackApiMethodResponse {
  ok: boolean;
  error?: string;
}

interface SlackPostMessageResponse extends SlackApiMethodResponse {
  ts?: string;
}

interface SlackAuthTestResponse extends SlackApiMethodResponse {
  user_id?: string;
  team_id?: string;
}

export class SlackBot {
  private readonly bridgeRuntime = createBridgeRuntime();
  private slackConfig = loadSlackBotConfig();
  private slackApi = new SlackWebApiClient(this.slackConfig.botToken, this.slackConfig.apiBaseUrl);
  private readonly adapter = new SlackAdapter(this.bridgeRuntime.router);
  private readonly recentEventIds = new Map<string, number>();
  private server?: Server;
  private botUserId?: string;
  private botTeamId?: string;

  async start(): Promise<void> {
    const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
    logSessionReconciliation("Slack bot startup", sessionRefresh);
    this.bridgeRuntime.startBackgroundServices();
    await this.refreshSlackClient();
    this.installSignalHandlers();

    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.slackConfig.port, this.slackConfig.host, () => {
        resolve();
      });
    });

    console.log(
      `Slack bot listening on http://${this.slackConfig.host}:${this.slackConfig.port}${this.slackConfig.commandPath} and ${this.slackConfig.eventsPath}.`
    );
  }

  async stop(): Promise<void> {
    this.bridgeRuntime.stopBackgroundServices();

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

  private async refreshSlackClient(): Promise<void> {
    this.slackApi = new SlackWebApiClient(this.slackConfig.botToken, this.slackConfig.apiBaseUrl);
    const auth = await this.slackApi.authTest();
    this.botUserId = auth.userId;
    this.botTeamId = auth.teamId;
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");

      if (method === "GET" && url.pathname === this.slackConfig.healthPath) {
        respondText(response, 200, "ok");
        return;
      }

      if (method !== "POST") {
        respondText(response, 404, "Not found");
        return;
      }

      const rawBody = await readRawBody(request);

      if (!verifySlackSignature(request, rawBody, this.slackConfig.signingSecret)) {
        respondText(response, 401, "Invalid Slack signature");
        return;
      }

      if (url.pathname === this.slackConfig.commandPath) {
        await this.handleCommandRequest(rawBody, response);
        return;
      }

      if (url.pathname === this.slackConfig.eventsPath) {
        await this.handleEventRequest(rawBody, response);
        return;
      }

      respondText(response, 404, "Not found");
    } catch (error) {
      console.error(formatBridgeFailure("Slack", error));

      if (!response.headersSent) {
        respondText(response, 500, "Slack bridge failure");
      } else {
        response.end();
      }
    }
  }

  private async handleCommandRequest(rawBody: Buffer, response: ServerResponse): Promise<void> {
    const payload = parseSlashCommandPayload(rawBody);
    respondText(response, 200, "");

    if (payload.ssl_check === "1") {
      return;
    }

    if (payload.command === "/codexadmin") {
      await this.handleAdminSlashCommand(payload);
      return;
    }

    if (payload.command !== "/codex") {
      await this.replyToResponseUrl(payload.response_url, "Unsupported Slack command.");
      return;
    }

    await this.handleCodexSlashCommand(payload);
  }

  private async handleEventRequest(rawBody: Buffer, response: ServerResponse): Promise<void> {
    const envelope = JSON.parse(rawBody.toString("utf8")) as SlackEventEnvelope;

    if (envelope.type === "url_verification") {
      respondJson(response, 200, {
        challenge: envelope.challenge ?? ""
      });
      return;
    }

    respondText(response, 200, "ok");

    if (envelope.type !== "event_callback" || !envelope.event) {
      return;
    }

    if (this.isDuplicateEvent(envelope.event_id)) {
      return;
    }

    await this.handleMessageEvent(envelope.team_id ?? this.botTeamId ?? "unknown", envelope.event);
  }

  private async handleCodexSlashCommand(payload: SlackSlashCommandPayload): Promise<void> {
    const commandLanguage = resolveConversationLanguage({
      text: payload.text
    });
    if (!this.isAllowedUser(payload.user_id)) {
      await this.replyToResponseUrl(
        payload.response_url,
        "This Slack integration is restricted to specific user IDs."
      );
      return;
    }

    const commandText = payload.text.trim().length > 0 ? `/codex ${payload.text.trim()}` : "/codex";
    const command = parseBridgeCommand(commandText);
    const existingTarget = this.resolveExistingConversationTargetFromCommand(payload);

    try {
      if (shouldUseEphemeralSlashReply(command, existingTarget)) {
        await this.adapter.handleTurn(
          this.buildSlackEnvelope({
            target: existingTarget,
            userId: payload.user_id,
            userDisplayName: payload.user_name,
            text: commandText,
            responseUrl: payload.response_url,
            messageMode: "ephemeral"
          })
        );
        return;
      }

      const target = await this.resolveConversationTargetForCommand(payload, command, existingTarget);
      await this.adapter.handleTurn(
        this.buildSlackEnvelope({
          target,
          userId: payload.user_id,
          userDisplayName: payload.user_name,
          text: command.kind === "conversation" ? command.text : commandText,
          responseUrl: payload.response_url,
          messageMode: "conversation"
        })
      );

      if (payload.response_url) {
        await this.replyToResponseUrl(
          payload.response_url,
          buildSlashCompletionMessage(command, target, commandLanguage)
        );
      }
    } catch (error) {
      await this.replyToResponseUrl(payload.response_url, formatBridgeFailure("Slack", error));
    }
  }

  private async handleAdminSlashCommand(payload: SlackSlashCommandPayload): Promise<void> {
    if (!this.isAdminUser(payload.user_id)) {
      await this.replyToResponseUrl(payload.response_url, "You are not allowed to use /codexadmin.");
      return;
    }

    const [rawCommand = "help"] = payload.text.trim().split(/\s+/);
    const command = rawCommand.toLowerCase();

    try {
      switch (command) {
        case "":
        case "help":
          await this.replyToResponseUrl(payload.response_url, buildSlackAdminHelp());
          return;
        case "status": {
          const snapshot = this.bridgeRuntime.getRepositoryRegistrySnapshot();
          await this.replyToResponseUrl(
            payload.response_url,
            [
              "Codex admin status:",
              `- Config source: ${this.slackConfig.configFilePath ?? "env"}`,
              `- Registry source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.slackConfig.allowedUserIds.length || "all"}`,
              `- Admin users configured: ${this.slackConfig.adminUserIds.length}`,
              `- Listening on: ${this.slackConfig.host}:${this.slackConfig.port}`,
              `- Command path: ${this.slackConfig.commandPath}`,
              `- Events path: ${this.slackConfig.eventsPath}`,
              `- Restart allowed: ${String(this.slackConfig.allowProcessRestart)}`
            ].join("\n")
          );
          return;
        }
        case "reloadconfig": {
          const previousHost = this.slackConfig.host;
          const previousPort = this.slackConfig.port;
          const previousCommandPath = this.slackConfig.commandPath;
          const previousEventsPath = this.slackConfig.eventsPath;

          const snapshot = this.bridgeRuntime.reloadRepositoryRegistry();
          const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
          this.slackConfig = loadSlackBotConfig();
          await this.refreshSlackClient();

          const notes: string[] = [];
          if (
            previousHost !== this.slackConfig.host ||
            previousPort !== this.slackConfig.port
          ) {
            notes.push("Listener host/port changes require a process restart.");
          }
          if (
            previousCommandPath !== this.slackConfig.commandPath ||
            previousEventsPath !== this.slackConfig.eventsPath
          ) {
            notes.push("Update the Slack app request URLs if the command or events path changed.");
          }

          await this.replyToResponseUrl(
            payload.response_url,
            [
              "Reloaded runtime config.",
              `- Config source: ${this.slackConfig.configFilePath ?? "env"}`,
              `- Registry source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.slackConfig.allowedUserIds.length || "all"}`,
              `- Admin users configured: ${this.slackConfig.adminUserIds.length}`,
              ...formatSessionReconciliationLines(sessionRefresh),
              ...notes
            ].join("\n")
          );
          return;
        }
        case "restart":
          if (!this.slackConfig.allowProcessRestart) {
            await this.replyToResponseUrl(
              payload.response_url,
              "Process restart is disabled. Set slack.allow_process_restart=true in nuntius.toml to enable it."
            );
            return;
          }

          await this.replyToResponseUrl(
            payload.response_url,
            isProcessGuardActive()
              ? "Restart requested. The process will exit now and the bundled guard will start a fresh process."
              : "Restart requested. The process will exit now; an external supervisor must start it again."
          );
          setTimeout(() => {
            process.exit(PROCESS_RESTART_EXIT_CODE);
          }, 250);
          return;
        default:
          await this.replyToResponseUrl(
            payload.response_url,
            `Unsupported /codexadmin command "${command}".\n${buildSlackAdminHelp()}`
          );
      }
    } catch (error) {
      await this.replyToResponseUrl(payload.response_url, formatBridgeFailure("Slack", error));
    }
  }

  private async handleMessageEvent(
    workspaceId: string,
    event: SlackMessageEvent
  ): Promise<void> {
    if (
      event.type !== "message" ||
      event.hidden ||
      event.bot_id ||
      !event.user ||
      (event.subtype !== undefined && event.subtype !== "file_share")
    ) {
      return;
    }

    if (!this.isAllowedUser(event.user)) {
      return;
    }

    try {
      if (event.channel_type === "im" || event.channel.startsWith("D")) {
        await this.handleDmMessageEvent(workspaceId, event);
        return;
      }

      if (event.thread_ts) {
        await this.handleThreadMessageEvent(workspaceId, event);
        return;
      }

      await this.handleRootChannelMessageEvent(workspaceId, event);
    } catch (error) {
      await this.postConversationFailure(
        {
          workspaceId,
          channelId: event.channel,
          threadId: event.thread_ts ?? event.ts,
          scope: event.thread_ts ? "thread" : "channel"
        },
        formatBridgeFailure("Slack", error)
      );
    }
  }

  private async handleDmMessageEvent(
    workspaceId: string,
    event: SlackMessageEvent
  ): Promise<void> {
    await this.adapter.handleTurn(
      this.buildSlackEnvelope({
        target: {
          workspaceId,
          channelId: event.channel,
          scope: "dm"
        },
        userId: event.user ?? "unknown",
        userDisplayName: event.user,
        text: (event.text ?? "").trim(),
        attachments: mapSlackAttachments(event.files),
        receivedAt: slackTimestampToIso(event.ts),
        sourceMessageTs: event.ts,
        messageMode: "conversation"
      })
    );
  }

  private async handleThreadMessageEvent(
    workspaceId: string,
    event: SlackMessageEvent
  ): Promise<void> {
    const target: SlackConversationTarget = {
      workspaceId,
      channelId: event.channel,
      threadId: event.thread_ts,
      scope: "thread"
    };
    const text = event.text ?? "";
    const mentionedBot = this.isBotMentioned(text);
    const status = await this.bridgeRuntime.bridge.getConversationStatus(
      buildSlackTurnSeed(target, event.user ?? "unknown", event.user)
    );

    if (!status.binding && !mentionedBot) {
      return;
    }

    const prompt = mentionedBot ? this.stripBotMention(text) : text.trim();
    const language = resolveConversationLanguage({
      binding: status.binding,
      text: prompt || text
    });
    const attachments = mapSlackAttachments(event.files);
    if (!prompt && attachments.length === 0) {
      await this.postConversationFailure(
        target,
        localize(language, {
          en: "Reply with a message for Codex or use `/codex help`.",
          zh: "请回复一条发给 Codex 的消息，或使用 `/codex help`。"
        })
      );
      return;
    }

    await this.adapter.handleTurn(
      this.buildSlackEnvelope({
        target,
        userId: event.user ?? "unknown",
        userDisplayName: event.user,
        text: prompt,
        attachments,
        receivedAt: slackTimestampToIso(event.ts),
        sourceMessageTs: event.ts,
        messageMode: "conversation"
      })
    );
  }

  private async handleRootChannelMessageEvent(
    workspaceId: string,
    event: SlackMessageEvent
  ): Promise<void> {
    const text = event.text ?? "";
    if (!this.isBotMentioned(text)) {
      return;
    }

    const prompt = this.stripBotMention(text);
    const language = resolveConversationLanguage({
      text: prompt || text
    });
    const attachments = mapSlackAttachments(event.files);
    const target: SlackConversationTarget = {
      workspaceId,
      channelId: event.channel,
      threadId: event.ts,
      scope: "thread"
    };

    if (!prompt && attachments.length === 0) {
      await this.postConversationFailure(
        target,
        localize(language, {
          en: "Mention me with a prompt, or use `/codex help` in the thread after I reply.",
          zh: "请在提及时附上你的请求，或等我回复后在该线程里使用 `/codex help`。"
        })
      );
      return;
    }

    await this.adapter.handleTurn(
      this.buildSlackEnvelope({
        target,
        userId: event.user ?? "unknown",
        userDisplayName: event.user,
        text: prompt,
        attachments,
        receivedAt: slackTimestampToIso(event.ts),
        sourceMessageTs: event.ts,
        messageMode: "conversation"
      })
    );
  }

  private async resolveConversationTargetForCommand(
    payload: SlackSlashCommandPayload,
    command: BridgeCommand,
    existingTarget: SlackConversationTarget
  ): Promise<SlackConversationTarget> {
    if (existingTarget.scope === "dm" || existingTarget.scope === "thread") {
      return existingTarget;
    }

    if (!requiresPersistentConversation(command)) {
      return existingTarget;
    }

    const starter = await this.slackApi.postMessage({
      channel: payload.channel_id,
      text: buildSlackThreadStarterMessage(
        payload.user_id,
        detectConversationLanguage(payload.text)
      )
    });

    if (!starter.ts) {
      throw new Error("Slack did not return a thread timestamp for the new conversation starter.");
    }

    return {
      workspaceId: payload.team_id,
      channelId: payload.channel_id,
      threadId: starter.ts,
      scope: "thread"
    };
  }

  private resolveExistingConversationTargetFromCommand(
    payload: SlackSlashCommandPayload
  ): SlackConversationTarget {
    const isDm = payload.channel_id.startsWith("D");
    if (isDm) {
      return {
        workspaceId: payload.team_id,
        channelId: payload.channel_id,
        scope: "dm"
      };
    }

    if (payload.thread_ts) {
      return {
        workspaceId: payload.team_id,
        channelId: payload.channel_id,
        threadId: payload.thread_ts,
        scope: "thread"
      };
    }

    return {
      workspaceId: payload.team_id,
      channelId: payload.channel_id,
      scope: "channel"
    };
  }

  private buildSlackEnvelope(input: {
    target: SlackConversationTarget;
    userId: string;
    userDisplayName?: string;
    text: string;
    attachments?: Attachment[];
    receivedAt?: string;
    responseUrl?: string;
    sourceMessageTs?: string;
    messageMode: "conversation" | "ephemeral";
  }): SlackEnvelope {
    const syncStatusReaction = input.sourceMessageTs
      ? createSlackStatusReactionSyncer(this.slackApi, {
          channelId: input.target.channelId,
          messageTs: input.sourceMessageTs
        })
      : undefined;

    return {
      workspaceId: input.target.workspaceId,
      channelId: input.target.channelId,
      threadId: input.target.threadId,
      scope: input.target.scope,
      userId: input.userId,
      userDisplayName: input.userDisplayName,
      text: input.text,
      attachments: input.attachments ?? [],
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      acknowledge: async () => undefined,
      postMessage: async (message) => {
        if (input.messageMode === "ephemeral") {
          await this.replyToResponseUrl(input.responseUrl, message);
          return {};
        }

        return this.postConversationMessage(input.target, message);
      },
      updateMessage:
        input.messageMode === "conversation"
          ? async (messageTs, message) => {
              await this.updateConversationMessage(input.target, messageTs, message);
            }
          : undefined,
      postEphemeral: input.responseUrl
        ? async (message) => {
            await this.replyToResponseUrl(input.responseUrl, message);
          }
        : undefined,
      syncStatusReaction
    };
  }

  private async postConversationMessage(
    target: SlackConversationTarget,
    message: string
  ): Promise<{ messageTs?: string }> {
    const result = await this.slackApi.postMessage({
      channel: target.channelId,
      text: message,
      threadTs: target.scope === "thread" ? target.threadId : undefined
    });

    return {
      messageTs: result.ts
    };
  }

  private async updateConversationMessage(
    target: SlackConversationTarget,
    messageTs: string,
    message: string
  ): Promise<void> {
    await this.slackApi.updateMessage({
      channel: target.channelId,
      ts: messageTs,
      text: message
    });
  }

  private async postConversationFailure(
    target: SlackConversationTarget,
    message: string
  ): Promise<void> {
    await this.postConversationMessage(target, message);
  }

  private async replyToResponseUrl(
    responseUrl: string | undefined,
    message: string
  ): Promise<void> {
    if (!responseUrl) {
      return;
    }

    await this.slackApi.postResponseMessage(responseUrl, message);
  }

  private isBotMentioned(text: string | undefined): boolean {
    if (!text || !this.botUserId) {
      return false;
    }

    return text.includes(`<@${this.botUserId}>`);
  }

  private stripBotMention(text: string): string {
    if (!this.botUserId) {
      return text.trim();
    }

    return text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
  }

  private isAllowedUser(userId: string): boolean {
    if (this.slackConfig.allowedUserIds.length === 0) {
      return true;
    }

    return this.slackConfig.allowedUserIds.includes(userId);
  }

  private isAdminUser(userId: string): boolean {
    return this.slackConfig.adminUserIds.includes(userId);
  }

  private isDuplicateEvent(eventId: string | undefined): boolean {
    const now = Date.now();

    for (const [existingEventId, seenAt] of this.recentEventIds.entries()) {
      if (now - seenAt > EVENT_DEDUP_TTL_MS) {
        this.recentEventIds.delete(existingEventId);
      }
    }

    if (!eventId) {
      return false;
    }

    if (this.recentEventIds.has(eventId)) {
      return true;
    }

    this.recentEventIds.set(eventId, now);
    return false;
  }
}

class SlackWebApiClient {
  constructor(
    private readonly botToken: string,
    private readonly apiBaseUrl: string
  ) {}

  async authTest(): Promise<SlackAuthTestResult> {
    const response = await this.callApi<SlackAuthTestResponse>("auth.test", {});
    if (!response.user_id) {
      throw new Error("Slack auth.test did not return a bot user ID.");
    }

    return {
      userId: response.user_id,
      teamId: response.team_id
    };
  }

  async postMessage(input: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<SlackPostMessageResponse> {
    return this.callApi<SlackPostMessageResponse>("chat.postMessage", {
      channel: input.channel,
      text: input.text,
      thread_ts: input.threadTs
    });
  }

  async updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<void> {
    await this.callApi<SlackApiMethodResponse>("chat.update", {
      channel: input.channel,
      ts: input.ts,
      text: input.text
    });
  }

  async addReaction(input: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<void> {
    await this.callApi<SlackApiMethodResponse>("reactions.add", {
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name
    });
  }

  async removeReaction(input: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<void> {
    await this.callApi<SlackApiMethodResponse>("reactions.remove", {
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name
    });
  }

  async postResponseMessage(responseUrl: string, text: string): Promise<void> {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: false,
        text
      })
    });

    if (!response.ok) {
      throw new Error(`Slack response_url request failed with HTTP ${response.status}.`);
    }
  }

  private async callApi<T extends SlackApiMethodResponse>(
    method: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(joinSlackApiUrl(this.apiBaseUrl, method), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Slack API ${method} failed with HTTP ${response.status}.`);
    }

    const parsed = (await response.json()) as T;
    if (!parsed.ok) {
      throw new Error(`Slack API ${method} failed: ${parsed.error ?? "unknown_error"}.`);
    }

    return parsed;
  }
}

function requiresPersistentConversation(command: BridgeCommand): boolean {
  return command.kind === "conversation" || command.kind === "bind";
}

function shouldUseEphemeralSlashReply(
  command: BridgeCommand,
  target: SlackConversationTarget
): boolean {
  if (target.scope === "channel") {
    return !requiresPersistentConversation(command);
  }

  return command.kind !== "conversation" && command.kind !== "bind";
}

function parseSlashCommandPayload(rawBody: Buffer): SlackSlashCommandPayload {
  const form = new URLSearchParams(rawBody.toString("utf8"));

  return {
    command: form.get("command") ?? "",
    text: form.get("text") ?? "",
    team_id: form.get("team_id") ?? "unknown",
    channel_id: form.get("channel_id") ?? "unknown",
    channel_name: form.get("channel_name") ?? undefined,
    user_id: form.get("user_id") ?? "unknown",
    user_name: form.get("user_name") ?? undefined,
    response_url: form.get("response_url") ?? undefined,
    thread_ts: form.get("thread_ts") ?? undefined,
    ssl_check: form.get("ssl_check") ?? undefined
  };
}

function verifySlackSignature(
  request: IncomingMessage,
  rawBody: Buffer,
  signingSecret: string
): boolean {
  const timestamp = readSingleHeader(request.headers["x-slack-request-timestamp"]);
  const signature = readSingleHeader(request.headers["x-slack-signature"]);

  if (!timestamp || !signature) {
    return false;
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
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

function buildSlackTurnSeed(
  target: SlackConversationTarget,
  userId: string,
  userDisplayName?: string
) {
  return {
    platform: "slack" as const,
    workspaceId: target.workspaceId,
    channelId: target.channelId,
    threadId: target.threadId,
    scope: target.scope,
    userId,
    userDisplayName,
    text: "",
    attachments: [],
    receivedAt: new Date().toISOString()
  };
}

function mapSlackAttachments(files: SlackFile[] | undefined): Attachment[] {
  return (files ?? []).map((file) => ({
    id: file.id,
    kind: file.mimetype?.startsWith("image/") ? "image" : "file",
    name: file.name,
    mimeType: file.mimetype,
    url: file.url_private_download ?? file.url_private
  }));
}

function slackTimestampToIso(value: string): string {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) {
    return new Date().toISOString();
  }

  return new Date(seconds * 1000).toISOString();
}

function createSlackStatusReactionSyncer(
  slackApi: SlackWebApiClient,
  target: {
    channelId: string;
    messageTs: string;
  }
): (status: ProcessingStatus) => Promise<void> {
  let currentStatus: ProcessingStatus | undefined;

  return async (status) => {
    if (currentStatus === status) {
      return;
    }

    const previousStatus = currentStatus;
    if (previousStatus) {
      try {
        await slackApi.removeReaction({
          channel: target.channelId,
          timestamp: target.messageTs,
          name: slackProcessingReactionName(previousStatus)
        });
      } catch {
        // Best-effort cleanup of the previous processing marker.
      }
    }

    await slackApi.addReaction({
      channel: target.channelId,
      timestamp: target.messageTs,
      name: slackProcessingReactionName(status)
    });
    currentStatus = status;
  };
}

function slackProcessingReactionName(status: ProcessingStatus): string {
  switch (status) {
    case "queued":
      return "hourglass_flowing_sand";
    case "working":
      return "hammer_and_wrench";
    case "finished":
      return "white_check_mark";
    case "failed":
      return "x";
    case "interrupted":
      return "warning";
  }
}

function joinSlackApiUrl(baseUrl: string, method: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${method}`;
}

function buildSlackAdminHelp(): string {
  return [
    "Codex admin commands:",
    "/codexadmin status",
    "/codexadmin reloadconfig",
    "/codexadmin restart",
    "/codexadmin help"
  ].join("\n");
}

function buildSlashCompletionMessage(
  command: BridgeCommand,
  target: SlackConversationTarget,
  language: "en" | "zh"
): string {
  if (command.kind === "bind") {
    return target.scope === "thread"
      ? localize(language, {
          en: "Bound in this thread.",
          zh: "已在此线程中绑定。"
        })
      : localize(language, {
          en: "Bound in this DM.",
          zh: "已在此私聊中绑定。"
        });
  }

  return target.scope === "thread"
    ? localize(language, {
        en: "Continuing in this thread.",
        zh: "将在此线程中继续。"
      })
    : localize(language, {
        en: "Continuing in this DM.",
        zh: "将在此私聊中继续。"
      });
}

function buildSlackThreadStarterMessage(userId: string, language: "en" | "zh"): string {
  return localize(language, {
    en: `Codex thread for <@${userId}>`,
    zh: `<@${userId}> 的 Codex 线程`
  });
}

export async function main(): Promise<void> {
  if (await maybeRelaunchCurrentProcessPersistently({ label: "Slack bot" })) {
    return;
  }

  if (!isProcessGuardActive()) {
    await runModuleWithRestartGuard({
      label: "Slack bot",
      modulePath: SLACK_MODULE_PATH
    });
    return;
  }

  const bot = new SlackBot();
  await bot.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
