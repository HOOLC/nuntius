import process from "node:process";

import { ThreadAutoArchiveDuration } from "discord.js";

import {
  loadNuntiusConfigFile,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  readTable
} from "./config-file.js";

export interface DiscordBotConfig {
  token: string;
  applicationId?: string;
  guildId?: string;
  threadAutoArchiveDuration: ThreadAutoArchiveDuration;
  threadNamePrefix: string;
  allowedUserIds: string[];
  adminUserIds: string[];
  allowProcessRestart: boolean;
  configFilePath?: string;
}

export function loadDiscordBotConfig(options?: {
  requireApplicationId?: boolean;
}): DiscordBotConfig {
  const loadedConfigFile = loadNuntiusConfigFile();
  const discordTable = loadedConfigFile ? readTable(loadedConfigFile.document, "discord") : undefined;
  const discordRecord = discordTable ?? {};

  const token = readString(discordRecord, "token") ?? readRequiredEnvString("NUNTIUS_DISCORD_TOKEN");
  const applicationId =
    readString(discordRecord, "application_id") ??
    readOptionalEnvString("NUNTIUS_DISCORD_APPLICATION_ID");

  if (options?.requireApplicationId && !applicationId) {
    throw new Error("Discord application_id must be configured in nuntius.toml or NUNTIUS_DISCORD_APPLICATION_ID.");
  }

  return {
    token,
    applicationId,
    guildId:
      readString(discordRecord, "guild_id") ?? readOptionalEnvString("NUNTIUS_DISCORD_GUILD_ID"),
    threadAutoArchiveDuration: parseThreadAutoArchiveDuration(
      readNumber(discordRecord, "thread_auto_archive_minutes"),
      process.env.NUNTIUS_DISCORD_THREAD_AUTO_ARCHIVE_MINUTES
    ),
    threadNamePrefix:
      readString(discordRecord, "thread_name_prefix") ??
      process.env.NUNTIUS_DISCORD_THREAD_PREFIX ??
      "codex",
    allowedUserIds:
      readStringArray(discordRecord, "allowed_user_ids") ??
      parseCsvEnv(process.env.NUNTIUS_DISCORD_ALLOWED_USER_IDS),
    adminUserIds:
      readStringArray(discordRecord, "admin_user_ids") ??
      parseCsvEnv(process.env.NUNTIUS_DISCORD_ADMIN_USER_IDS),
    allowProcessRestart:
      readBoolean(discordRecord, "allow_process_restart") ??
      parseBooleanEnv(process.env.NUNTIUS_ALLOW_PROCESS_RESTART, false),
    configFilePath: loadedConfigFile?.path
  };
}

function parseThreadAutoArchiveDuration(
  fileValue: number | undefined,
  envValue: string | undefined
): ThreadAutoArchiveDuration {
  if (fileValue !== undefined) {
    return mapThreadAutoArchiveDuration(fileValue, "discord.thread_auto_archive_minutes");
  }

  if (!envValue) {
    return ThreadAutoArchiveDuration.OneDay;
  }

  return mapThreadAutoArchiveDuration(Number.parseInt(envValue, 10), "NUNTIUS_DISCORD_THREAD_AUTO_ARCHIVE_MINUTES");
}

function mapThreadAutoArchiveDuration(
  value: number,
  sourceName: string
): ThreadAutoArchiveDuration {
  switch (value) {
    case 60:
      return ThreadAutoArchiveDuration.OneHour;
    case 1440:
      return ThreadAutoArchiveDuration.OneDay;
    case 4320:
      return ThreadAutoArchiveDuration.ThreeDays;
    case 10080:
      return ThreadAutoArchiveDuration.OneWeek;
    default:
      throw new Error(
        `${sourceName} must be one of 60, 1440, 4320, or 10080.`
      );
  }
}

function readRequiredEnvString(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required when it is not set in nuntius.toml.`);
  }

  return value;
}

function readOptionalEnvString(key: string): string | undefined {
  const value = process.env[key];
  if (!value) {
    return undefined;
  }

  return value;
}

function parseCsvEnv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`Expected a boolean string but received ${raw}.`);
}
