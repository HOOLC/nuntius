import type {
  Message,
  NewsChannel,
  PublicThreadChannel,
  TextChannel
} from "discord.js";

import { localize } from "./conversation-language.js";
import { buildDiscordThreadName } from "./discord-thread-name.js";

export interface DiscordConversationThreadOptions {
  userLabel: string;
  promptSeed: string;
  language: "en" | "zh";
  threadNamePrefix: string;
  threadAutoArchiveDuration: number;
}

export async function createConversationThreadFromMessage(
  message: Message,
  options: DiscordConversationThreadOptions
): Promise<PublicThreadChannel<false>> {
  return message.startThread({
    name: buildDiscordThreadName(options.threadNamePrefix, options.promptSeed),
    autoArchiveDuration: options.threadAutoArchiveDuration,
    reason: `Codex conversation created for ${options.userLabel}`
  });
}

export async function createConversationThreadFromChannel(
  channel: TextChannel | NewsChannel,
  options: DiscordConversationThreadOptions
): Promise<PublicThreadChannel<false>> {
  const starterMessage = await channel.send({
    content: localize(options.language, {
      en: `Codex thread for ${options.userLabel}`,
      zh: `${options.userLabel} 的 Codex 线程`
    })
  });

  return starterMessage.startThread({
    name: buildDiscordThreadName(options.threadNamePrefix, options.promptSeed),
    autoArchiveDuration: options.threadAutoArchiveDuration,
    reason: `Codex conversation created for ${options.userLabel}`
  });
}
