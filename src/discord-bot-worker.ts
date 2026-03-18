import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  type MessageReaction,
  Partials,
  type ChatInputCommandInteraction,
  type NewsChannel,
  type PublicThreadChannel,
  type TextChannel,
  type ThreadChannel
} from "discord.js";

import { DiscordAdapter } from "./adapters/discord.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import {
  detectConversationLanguage,
  localize,
  resolveConversationLanguage
} from "./conversation-language.js";
import { loadDiscordBotConfig } from "./discord-config.js";
import {
  sendDiscordInteractionResponse,
  sendDiscordText,
  type DiscordInteractionDeliveryState,
  type DiscordSendableChannel
} from "./discord-delivery.js";
import type { Attachment, ProcessingStatus } from "./domain.js";
import { isProcessGuardActive, PROCESS_RESTART_EXIT_CODE } from "./process-guard.js";
import {
  isSupervisorToWorkerMessage,
  type DiscordWorkerMode,
  type WorkerToSupervisorMessage
} from "./discord-supervisor-protocol.js";

const DM_WORKSPACE_ID = "dm";
const BRIDGE_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_OUTPUT_LINE_LIMIT = 40;
const BUILD_OUTPUT_CHAR_LIMIT = 3500;

interface ConversationTarget {
  workspaceId: string;
  channelId: string;
  threadId?: string;
  scope: "dm" | "thread";
  outputChannel: DiscordSendableChannel;
}

class DiscordBotWorker {
  private readonly bridgeRuntime = createBridgeRuntime();
  private discordConfig = loadDiscordBotConfig();
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });
  private readonly adapter = new DiscordAdapter(this.bridgeRuntime.router);
  private stopped = false;

  async start(): Promise<void> {
    const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
    logSessionReconciliation("Discord worker startup", sessionRefresh);

    this.client.once(Events.ClientReady, (client) => {
      console.log(`Discord bot connected as ${client.user.tag}.`);
      sendWorkerMessage({
        type: "ready",
        tag: client.user.tag
      });
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      if (!this.isAllowedUser(interaction.user.id)) {
        await replyEphemeral(
          interaction,
          "This Discord integration is restricted to specific user IDs."
        );
        return;
      }

      if (interaction.commandName === "codex") {
        await this.handleCommandInteraction(interaction);
        return;
      }

      if (interaction.commandName === "codexadmin") {
        await this.handleAdminCommandInteraction(interaction);
      }
    });

    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message);
    });

    await this.client.login(this.discordConfig.token);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.client.removeAllListeners();
    this.client.destroy();
  }

  private async handleCommandInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case "ask":
          await this.handleAskInteraction(interaction);
          return;
        case "bind":
          await this.handleBindInteraction(interaction);
          return;
        case "status":
          await this.handleDirectInteractionCommand(interaction, "/codex status");
          return;
        case "repos":
          await this.handleDirectInteractionCommand(interaction, "/codex repos");
          return;
        case "reset": {
          const scope = interaction.options.getString("scope") ?? "all";
          await this.handleDirectInteractionCommand(interaction, `/codex reset ${scope}`);
          return;
        }
        case "interrupt":
          await this.handleDirectInteractionCommand(interaction, "/codex interrupt");
          return;
        case "help":
          await this.handleDirectInteractionCommand(interaction, "/codex help");
          return;
        default:
          await replyEphemeral(interaction, "Unsupported /codex subcommand.");
      }
    } catch (error) {
      await replyEphemeral(
        interaction,
        formatTopLevelError(error)
      );
    }
  }

  private async handleAdminCommandInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!this.isAdminUser(interaction.user.id)) {
      await replyEphemeral(interaction, "You are not allowed to use /codexadmin.");
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case "status": {
          const snapshot = this.bridgeRuntime.getRepositoryRegistrySnapshot();
          await replyEphemeral(
            interaction,
            [
              "Codex admin status:",
              `- Config source: ${this.discordConfig.configFilePath ?? "env"}`,
              `- Registry source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.discordConfig.allowedUserIds.length || "all"}`,
              `- Hot reload available: ${String(this.isSupervisorAvailable())}`,
              `- Restart allowed: ${String(this.discordConfig.allowProcessRestart)}`,
              `- Admin users configured: ${this.discordConfig.adminUserIds.length}`
            ].join("\n")
          );
          return;
        }
        case "reloadconfig": {
          const snapshot = this.bridgeRuntime.reloadRepositoryRegistry();
          this.discordConfig = loadDiscordBotConfig();
          const sessionRefresh = await this.bridgeRuntime.reconcileSessionBindings();
          await replyEphemeral(
            interaction,
            [
              "Reloaded runtime config.",
              `- Config source: ${this.discordConfig.configFilePath ?? "env"}`,
              `- Source: ${snapshot.source}${snapshot.sourcePath ? ` (${snapshot.sourcePath})` : ""}`,
              `- Default repo: ${snapshot.defaultRepositoryId}`,
              `- Repo count: ${snapshot.repositoryTargets.length}`,
              `- Allowed users configured: ${this.discordConfig.allowedUserIds.length || "all"}`,
              `- Admin users configured: ${this.discordConfig.adminUserIds.length}`,
              ...formatSessionReconciliationLines(sessionRefresh)
            ].join("\n")
          );
          return;
        }
        case "hotreload":
          await replyEphemeral(
            interaction,
            "Rebuilding the bridge and registering Discord commands now. If both succeed, I will request a hot reload next."
          );

          const buildResult = await rebuildDiscordBridge();
          if (!buildResult.ok) {
            await replyEphemeral(
              interaction,
              formatScriptFailure("Build", buildResult.output, "No build output was captured.")
            );
            return;
          }

          const registerResult = await registerDiscordCommands();
          if (!registerResult.ok) {
            await replyEphemeral(
              interaction,
              formatScriptFailure(
                "Discord command registration",
                registerResult.output,
                "No command registration output was captured."
              )
            );
            return;
          }

          if (!this.isSupervisorAvailable()) {
            await replyEphemeral(
              interaction,
              [
                "Build and command registration succeeded, but hot reload is unavailable because the bot is not running under the bundled supervisor.",
                formatScriptSuccessSummary("Build output", buildResult.output, "Build completed successfully."),
                formatScriptSuccessSummary(
                  "Discord command registration output",
                  registerResult.output,
                  "Discord commands registered successfully."
                )
              ].join("\n\n")
            );
            return;
          }

          await replyEphemeral(
            interaction,
            [
              "Build and command registration succeeded. Hot reload requested.",
              "Existing session bindings will be reconciled when the new worker starts.",
              formatScriptSuccessSummary("Build output", buildResult.output, "Build completed successfully."),
              formatScriptSuccessSummary(
                "Discord command registration output",
                registerResult.output,
                "Discord commands registered successfully."
              )
            ].join("\n\n")
          );
          sendWorkerMessage({
            type: "request_hot_reload"
          });
          return;
        case "restart":
          if (!this.discordConfig.allowProcessRestart) {
            await replyEphemeral(
              interaction,
              "Process restart is disabled. Set allow_process_restart=true in nuntius.toml to enable it."
            );
            return;
          }

          if (this.isSupervisorAvailable()) {
            await replyEphemeral(
              interaction,
              isProcessGuardActive()
                ? "Restart requested. The supervisor will exit now and the bundled guard will start a fresh process."
                : "Restart requested. The supervisor will exit now; start it again or use an external service manager."
            );
            sendWorkerMessage({
              type: "request_restart"
            });
            return;
          }

          await replyEphemeral(
            interaction,
            isProcessGuardActive()
              ? "Restart requested. The process will exit now and the bundled guard will start a fresh process."
              : "Restart requested. The process will exit now; an external supervisor must start it again."
          );
          setTimeout(() => {
            this.client.destroy();
            process.exit(PROCESS_RESTART_EXIT_CODE);
          }, 250);
          return;
        default:
          await replyEphemeral(interaction, "Unsupported /codexadmin subcommand.");
      }
    } catch (error) {
      await replyEphemeral(interaction, formatTopLevelError(error));
    }
  }

  private async handleAskInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const prompt = interaction.options.getString("prompt", true);
    const repositoryId = interaction.options.getString("repo") ?? undefined;
    const target = await this.resolveConversationTargetFromInteraction(interaction, {
      createThreadIfNeeded: true,
      promptSeed: prompt
    });
    const ack = new InteractionAck(interaction);

    if (repositoryId) {
      await this.bridgeRuntime.bridge.bindConversation(
        buildTurnSeed({
          target,
          userId: interaction.user.id,
          userDisplayName: interaction.member && "displayName" in interaction.member
            ? interaction.member.displayName
            : interaction.user.globalName ?? interaction.user.username
        }),
        repositoryId
      );
    }

    await this.adapter.handleTurn({
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      threadId: target.threadId,
      scope: target.scope,
      userId: interaction.user.id,
      userDisplayName:
        interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : interaction.user.globalName ?? interaction.user.username,
      text: prompt,
      repositoryId,
      receivedAt: new Date().toISOString(),
      deferReply: () => ack.defer(),
      startTyping: () => startDiscordTyping(target.outputChannel),
      followUp: (message) => sendDiscordText(target.outputChannel, message)
    });

    const language = detectConversationLanguage(prompt);
    await ack.complete(
      target.threadId
        ? localize(language, {
            en: `Continuing in <#${target.threadId}>.`,
            zh: `将在 <#${target.threadId}> 中继续。`
          })
        : localize(language, {
            en: "Continuing in this DM.",
            zh: "将在此私聊中继续。"
          })
    );
  }

  private async handleBindInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const repositoryId = interaction.options.getString("repo", true);
    const target = await this.resolveConversationTargetFromInteraction(interaction, {
      createThreadIfNeeded: true,
      promptSeed: repositoryId
    });
    const ack = new InteractionAck(interaction);

    await this.adapter.handleTurn({
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      threadId: target.threadId,
      scope: target.scope,
      userId: interaction.user.id,
      userDisplayName:
        interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : interaction.user.globalName ?? interaction.user.username,
      text: `/codex bind ${repositoryId}`,
      receivedAt: new Date().toISOString(),
      deferReply: () => ack.defer(),
      startTyping: () => startDiscordTyping(target.outputChannel),
      followUp: (message) => sendDiscordText(target.outputChannel, message)
    });

    const status = target.threadId
      ? await this.bridgeRuntime.bridge.getConversationStatus(
          buildTurnSeed({
            target,
            userId: interaction.user.id,
            userDisplayName:
              interaction.member && "displayName" in interaction.member
                ? interaction.member.displayName
                : interaction.user.globalName ?? interaction.user.username
          })
        )
      : undefined;
    const language = resolveConversationLanguage({
      binding: status?.binding,
      text: repositoryId
    });
    await ack.complete(
      target.threadId
        ? localize(language, {
            en: `Bound in <#${target.threadId}>.`,
            zh: `已在 <#${target.threadId}> 中绑定。`
          })
        : localize(language, {
            en: "Bound in this DM.",
            zh: "已在此私聊中绑定。"
          })
    );
  }

  private async handleDirectInteractionCommand(
    interaction: ChatInputCommandInteraction,
    text: string
  ): Promise<void> {
    const target = this.tryResolveExistingConversationTargetFromInteraction(interaction);
    const ack = new InteractionAck(interaction);
    const directSink = async (message: string) => ack.send(message);

    await this.adapter.handleTurn({
      workspaceId: target?.workspaceId ?? deriveWorkspaceId(interaction.guildId),
      channelId: target?.channelId ?? interaction.channelId,
      threadId: target?.threadId,
      scope: target?.scope ?? (interaction.inGuild() ? "channel" : "dm"),
      userId: interaction.user.id,
      userDisplayName:
        interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : interaction.user.globalName ?? interaction.user.username,
      text,
      receivedAt: new Date().toISOString(),
      deferReply: () => ack.defer(),
      followUp: directSink
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || (message.content.length === 0 && message.attachments.size === 0)) {
      return;
    }

    if (!this.isAllowedUser(message.author.id)) {
      return;
    }

    try {
      if (message.channel.isDMBased()) {
        await this.handleDmMessage(message);
        return;
      }

      if (message.channel.isThread()) {
        await this.handleThreadMessage(message);
        return;
      }

      await this.handleMentionInGuildChannel(message);
    } catch (error) {
      await sendDiscordText(asSendableChannel(message.channel), formatTopLevelError(error));
    }
  }

  private async handleDmMessage(message: Message): Promise<void> {
    await this.adapter.handleTurn({
      workspaceId: DM_WORKSPACE_ID,
      channelId: message.channel.id,
      scope: "dm",
      userId: message.author.id,
      userDisplayName: message.author.globalName ?? message.author.username,
      text: message.content.trim(),
      attachments: mapMessageAttachments(message),
      receivedAt: message.createdAt.toISOString(),
      deferReply: async () => undefined,
      startTyping: () => startDiscordTyping(asSendableChannel(message.channel)),
      followUp: (content) => sendDiscordText(asSendableChannel(message.channel), content),
      syncStatusReaction: createDiscordStatusReactionSyncer(message)
    });
  }

  private async handleThreadMessage(message: Message): Promise<void> {
    const thread = message.channel as ThreadChannel;
    const strippedContent = this.stripBotMention(message.content);
    const target = this.buildConversationTargetForThread(thread);
    const status = await this.bridgeRuntime.bridge.getConversationStatus(
      buildTurnSeed({
        target,
        userId: message.author.id,
        userDisplayName:
          message.member?.displayName ?? message.author.globalName ?? message.author.username
      })
    );
    const mentionedBot = this.isBotMentioned(message);

    if (!status.binding && !mentionedBot) {
      return;
    }

    const text = mentionedBot ? strippedContent : message.content.trim();
    const language = resolveConversationLanguage({
      binding: status.binding,
      text
    });
    if (!text && message.attachments.size === 0) {
      await sendDiscordText(
        thread,
        localize(language, {
          en: "Reply with a message for Codex or use `/codex help`.",
          zh: "请回复一条发给 Codex 的消息，或使用 `/codex help`。"
        })
      );
      return;
    }

    await this.adapter.handleTurn({
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      threadId: target.threadId,
      scope: "thread",
      userId: message.author.id,
      userDisplayName:
        message.member?.displayName ?? message.author.globalName ?? message.author.username,
      text,
      attachments: mapMessageAttachments(message),
      receivedAt: message.createdAt.toISOString(),
      deferReply: async () => undefined,
      startTyping: () => startDiscordTyping(thread),
      followUp: (content) => sendDiscordText(thread, content),
      syncStatusReaction: createDiscordStatusReactionSyncer(message)
    });
  }

  private async handleMentionInGuildChannel(message: Message): Promise<void> {
    if (!this.isBotMentioned(message)) {
      return;
    }

    const text = this.stripBotMention(message.content);
    const language = detectConversationLanguage(text || message.content);
    if (!text && message.attachments.size === 0) {
      await sendDiscordText(
        asSendableChannel(message.channel),
        localize(language, {
          en: "Mention me with a prompt, or use `/codex ask prompt:<text>` to start a Codex thread.",
          zh: "请在提及时附上你的请求，或使用 `/codex ask prompt:<text>` 来启动一个 Codex 线程。"
        })
      );
      return;
    }

    if (!isThreadStarterChannel(message.channel)) {
      await sendDiscordText(
        asSendableChannel(message.channel),
        localize(language, {
          en: [
            "Start Codex from a text channel, announcement channel, existing thread, or a DM.",
            `Detected channel type: ${describeDiscordChannelType(message.channel)}.`
          ].join(" "),
          zh: [
            "请在文本频道、公告频道、现有线程或私聊中启动 Codex。",
            `检测到的频道类型：${describeDiscordChannelType(message.channel)}。`
          ].join(" ")
        })
      );
      return;
    }

    const thread = await this.createConversationThread(message.channel, {
      userLabel: message.member?.displayName ?? message.author.username,
      promptSeed: text,
      language
    });
    const target = this.buildConversationTargetForThread(thread);

    await this.adapter.handleTurn({
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      threadId: target.threadId,
      scope: "thread",
      userId: message.author.id,
      userDisplayName:
        message.member?.displayName ?? message.author.globalName ?? message.author.username,
      text,
      attachments: mapMessageAttachments(message),
      receivedAt: message.createdAt.toISOString(),
      deferReply: async () => undefined,
      startTyping: () => startDiscordTyping(thread),
      followUp: (content) => sendDiscordText(thread, content),
      syncStatusReaction: createDiscordStatusReactionSyncer(message)
    });
  }

  private async resolveConversationTargetFromInteraction(
    interaction: ChatInputCommandInteraction,
    options: {
      createThreadIfNeeded: boolean;
      promptSeed: string;
    }
  ): Promise<ConversationTarget> {
    const existing = this.tryResolveExistingConversationTargetFromInteraction(interaction);
    if (existing) {
      return existing;
    }

    if (!options.createThreadIfNeeded) {
      throw new Error("This command must be run inside a DM or a Codex thread.");
    }

    if (!interaction.channel || !isThreadStarterChannel(interaction.channel)) {
      const language = detectConversationLanguage(options.promptSeed);
      throw new Error(
        localize(language, {
          en: [
            "This command can create a Codex thread only from a guild text channel, an announcement channel, or a DM.",
            `Detected channel type: ${describeDiscordChannelType(interaction.channel)}.`
          ].join(" "),
          zh: [
            "该命令只能在服务器文本频道、公告频道或私聊中创建 Codex 线程。",
            `检测到的频道类型：${describeDiscordChannelType(interaction.channel)}。`
          ].join(" ")
        })
      );
    }

    const thread = await this.createConversationThread(interaction.channel, {
      userLabel:
        interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : interaction.user.username,
      promptSeed: options.promptSeed,
      language: detectConversationLanguage(options.promptSeed)
    });

    return this.buildConversationTargetForThread(thread);
  }

  private tryResolveExistingConversationTargetFromInteraction(
    interaction: ChatInputCommandInteraction
  ): ConversationTarget | undefined {
    const channel = interaction.channel;
    if (!channel) {
      return undefined;
    }

    if (channel.isDMBased()) {
      return {
        workspaceId: DM_WORKSPACE_ID,
        channelId: channel.id,
        scope: "dm",
        outputChannel: asSendableChannel(channel)
      };
    }

    if (channel.isThread()) {
      return this.buildConversationTargetForThread(channel);
    }

    return undefined;
  }

  private buildConversationTargetForThread(
    thread: ThreadChannel
  ): ConversationTarget {
    return {
      workspaceId: deriveWorkspaceId(thread.guildId),
      channelId: thread.parentId ?? thread.id,
      threadId: thread.id,
      scope: "thread",
      outputChannel: asSendableChannel(thread)
    };
  }

  private async createConversationThread(
    channel: TextChannel | NewsChannel,
    options: {
      userLabel: string;
      promptSeed: string;
      language: "en" | "zh";
    }
  ): Promise<PublicThreadChannel<false>> {
    const starterMessage = await channel.send({
      content: localize(options.language, {
        en: `Codex thread for ${options.userLabel}`,
        zh: `${options.userLabel} 的 Codex 线程`
      })
    });

    return starterMessage.startThread({
      name: buildThreadName(this.discordConfig.threadNamePrefix, options.promptSeed),
      autoArchiveDuration: this.discordConfig.threadAutoArchiveDuration,
      reason: `Codex conversation created for ${options.userLabel}`
    });
  }

  private isBotMentioned(message: Message): boolean {
    const botUser = this.client.user;
    if (!botUser) {
      return false;
    }

    return message.mentions.users.has(botUser.id);
  }

  private stripBotMention(content: string): string {
    const botUser = this.client.user;
    if (!botUser) {
      return content.trim();
    }

    return content
      .replace(new RegExp(`<@!?${botUser.id}>`, "g"), "")
      .trim();
  }

  private isAdminUser(userId: string): boolean {
    return this.discordConfig.adminUserIds.includes(userId);
  }

  private isAllowedUser(userId: string): boolean {
    if (this.discordConfig.allowedUserIds.length === 0) {
      return true;
    }

    return this.discordConfig.allowedUserIds.includes(userId);
  }

  private isSupervisorAvailable(): boolean {
    return typeof process.send === "function";
  }
}

class InteractionAck {
  private readonly deliveryState: DiscordInteractionDeliveryState = {
    initialResponseSent: false
  };

  constructor(private readonly interaction: ChatInputCommandInteraction) {}

  async defer(): Promise<void> {
    if (this.interaction.deferred || this.interaction.replied) {
      return;
    }

    await this.interaction.deferReply({
      ephemeral: true
    });
  }

  async send(content: string): Promise<void> {
    await sendDiscordInteractionResponse(
      this.interaction,
      content,
      this.deliveryState
    );
  }

  async complete(content: string): Promise<void> {
    await this.send(content);
  }
}

function buildThreadName(prefix: string, seed: string): string {
  const normalizedSeed = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  const suffix = normalizedSeed || "session";
  return `${prefix}-${suffix}`.slice(0, 100);
}

function isThreadStarterChannel(channel: unknown): channel is TextChannel | NewsChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "type" in channel &&
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
  );
}

function describeDiscordChannelType(channel: unknown): string {
  if (
    typeof channel === "object" &&
    channel !== null &&
    "type" in channel &&
    typeof channel.type === "number"
  ) {
    return ChannelType[channel.type] ?? String(channel.type);
  }

  return "unknown";
}

async function startDiscordTyping(
  channel: DiscordSendableChannel
): Promise<{ stop(): Promise<void> }> {
  if (typeof channel.sendTyping !== "function") {
    return {
      async stop(): Promise<void> {
        return undefined;
      }
    };
  }

  const sendTypingNow = channel.sendTyping.bind(channel);
  let stopped = false;
  const sendTyping = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      await sendTypingNow();
    } catch {
      // Typing failures should not abort the Discord turn.
    }
  };

  await sendTyping();
  const timer = setInterval(() => {
    void sendTyping();
  }, 8_000);

  return {
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(timer);
    }
  };
}

function createDiscordStatusReactionSyncer(
  message: Message
): (status: ProcessingStatus) => Promise<void> {
  let currentStatus: ProcessingStatus | undefined;
  let currentReaction: MessageReaction | undefined;

  return async (status) => {
    if (currentStatus === status) {
      return;
    }

    const previousReaction = currentReaction;
    if (previousReaction) {
      try {
        await previousReaction.users.remove();
      } catch {
        // Best-effort cleanup of the previous processing marker.
      }
    }

    currentReaction = await message.react(discordProcessingEmoji(status));
    currentStatus = status;
  };
}

function discordProcessingEmoji(status: ProcessingStatus): string {
  switch (status) {
    case "queued":
      return "⏳";
    case "working":
      return "🛠️";
    case "finished":
      return "✅";
    case "failed":
      return "❌";
    case "interrupted":
      return "⚠️";
  }
}

function mapMessageAttachments(message: Message): Attachment[] {
  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    kind: attachment.contentType?.startsWith("image/") ? "image" : "file",
    name: attachment.name ?? undefined,
    mimeType: attachment.contentType ?? undefined,
    url: attachment.url
  }));
}

function buildTurnSeed(input: {
  target: ConversationTarget;
  userId: string;
  userDisplayName?: string;
}) {
  return {
    platform: "discord" as const,
    workspaceId: input.target.workspaceId,
    channelId: input.target.channelId,
    threadId: input.target.threadId,
    scope: input.target.scope,
    userId: input.userId,
    userDisplayName: input.userDisplayName,
    text: "",
    attachments: [],
    receivedAt: new Date().toISOString()
  };
}

function deriveWorkspaceId(guildId: string | null): string {
  return guildId ?? DM_WORKSPACE_ID;
}

function asSendableChannel(channel: unknown): DiscordSendableChannel {
  if (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof channel.send === "function"
  ) {
    return channel as DiscordSendableChannel;
  }

  throw new Error("This Discord channel cannot accept bot messages.");
}

async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  content: string
): Promise<void> {
  await sendDiscordInteractionResponse(interaction, content);
}

async function rebuildDiscordBridge(): Promise<{
  ok: boolean;
  output: string;
}> {
  return runBridgeScript("build");
}

async function registerDiscordCommands(): Promise<{
  ok: boolean;
  output: string;
}> {
  return runBridgeScript("discord:register");
}

async function runBridgeScript(scriptName: string): Promise<{
  ok: boolean;
  output: string;
}> {
  const child = spawn(getNpmCommand(), ["run", scriptName], {
    cwd: BRIDGE_PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const lines: string[] = [];
  const appendLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    lines.push(line);
    if (lines.length > BUILD_OUTPUT_LINE_LIMIT) {
      lines.splice(0, lines.length - BUILD_OUTPUT_LINE_LIMIT);
    }
  };

  const stdoutReader = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  const stdoutTask = (async () => {
    for await (const line of stdoutReader) {
      appendLine(line);
    }
  })();

  const stderrReader = readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity
  });

  const stderrTask = (async () => {
    for await (const line of stderrReader) {
      appendLine(line);
    }
  })();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  await Promise.all([stdoutTask, stderrTask]);

  return {
    ok: exitCode === 0,
    output: clipScriptOutput(lines.join("\n"))
  };
}

function getNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function clipScriptOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= BUILD_OUTPUT_CHAR_LIMIT) {
    return trimmed;
  }

  return `${trimmed.slice(trimmed.length - BUILD_OUTPUT_CHAR_LIMIT)}\n[truncated]`;
}

function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
}

function formatScriptFailure(label: string, output: string, fallback: string): string {
  return [
    `**${label} failed**`,
    "```text",
    trimCodeFencePayload(output || fallback),
    "```"
  ].join("\n");
}

function formatScriptSuccessSummary(label: string, output: string, fallback: string): string {
  const body = output || fallback;
  return [
    `**${label}**`,
    "```text",
    trimCodeFencePayload(body),
    "```"
  ].join("\n");
}

function formatTopLevelError(error: unknown): string {
  if (error instanceof Error) {
    return `Discord bridge failure: ${error.message}`;
  }

  return "Discord bridge failure: unknown error.";
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

function sendWorkerMessage(message: WorkerToSupervisorMessage): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

async function probeWorkerStart(): Promise<void> {
  loadDiscordBotConfig();
  createBridgeRuntime();
  sendWorkerMessage({
    type: "probe_ready"
  });
}

async function main(): Promise<void> {
  const mode = (process.env.NUNTIUS_DISCORD_WORKER_MODE ?? "run") as DiscordWorkerMode;

  if (mode === "probe") {
    await probeWorkerStart();
    return;
  }

  const bot = new DiscordBotWorker();
  let shutdownRequested = false;

  const shutdown = async (exitCode: number): Promise<void> => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    try {
      await bot.stop();
    } finally {
      process.exit(exitCode);
    }
  };

  process.on("message", (message) => {
    if (isSupervisorToWorkerMessage(message) && message.type === "shutdown") {
      void shutdown(0);
    }
  });

  process.on("disconnect", () => {
    void shutdown(0);
  });

  process.on("SIGINT", () => {
    void shutdown(0);
  });

  process.on("SIGTERM", () => {
    void shutdown(0);
  });

  await bot.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
