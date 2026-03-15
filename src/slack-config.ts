import process from "node:process";

import {
  loadNuntiusConfigFile,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  readTable
} from "./config-file.js";

export interface SlackBotConfig {
  botToken: string;
  signingSecret: string;
  host: string;
  port: number;
  commandPath: string;
  eventsPath: string;
  healthPath: string;
  allowedUserIds: string[];
  adminUserIds: string[];
  allowProcessRestart: boolean;
  apiBaseUrl: string;
  configFilePath?: string;
}

export function loadSlackBotConfig(): SlackBotConfig {
  const loadedConfigFile = loadNuntiusConfigFile();
  const slackTable = loadedConfigFile ? readTable(loadedConfigFile.document, "slack") : undefined;
  const slackRecord = slackTable ?? {};

  return {
    botToken: readString(slackRecord, "bot_token") ?? readRequiredEnvString("NUNTIUS_SLACK_BOT_TOKEN"),
    signingSecret:
      readString(slackRecord, "signing_secret") ??
      readRequiredEnvString("NUNTIUS_SLACK_SIGNING_SECRET"),
    host: readString(slackRecord, "host") ?? process.env.NUNTIUS_SLACK_HOST ?? "0.0.0.0",
    port: parsePort(
      readNumber(slackRecord, "port"),
      process.env.NUNTIUS_SLACK_PORT
    ),
    commandPath:
      readString(slackRecord, "command_path") ??
      process.env.NUNTIUS_SLACK_COMMAND_PATH ??
      "/slack/commands",
    eventsPath:
      readString(slackRecord, "events_path") ??
      process.env.NUNTIUS_SLACK_EVENTS_PATH ??
      "/slack/events",
    healthPath:
      readString(slackRecord, "health_path") ??
      process.env.NUNTIUS_SLACK_HEALTH_PATH ??
      "/healthz",
    allowedUserIds:
      readStringArray(slackRecord, "allowed_user_ids") ??
      parseCsvEnv(process.env.NUNTIUS_SLACK_ALLOWED_USER_IDS),
    adminUserIds:
      readStringArray(slackRecord, "admin_user_ids") ??
      parseCsvEnv(process.env.NUNTIUS_SLACK_ADMIN_USER_IDS),
    allowProcessRestart:
      readBoolean(slackRecord, "allow_process_restart") ??
      parseBooleanEnv(process.env.NUNTIUS_SLACK_ALLOW_PROCESS_RESTART, false),
    apiBaseUrl:
      readString(slackRecord, "api_base_url") ??
      process.env.NUNTIUS_SLACK_API_BASE_URL ??
      "https://slack.com/api",
    configFilePath: loadedConfigFile?.path
  };
}

function parsePort(fileValue: number | undefined, envValue: string | undefined): number {
  if (fileValue !== undefined) {
    return ensurePort(fileValue, "slack.port");
  }

  if (!envValue) {
    return 8788;
  }

  return ensurePort(Number.parseInt(envValue, 10), "NUNTIUS_SLACK_PORT");
}

function ensurePort(value: number, sourceName: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${sourceName} must be an integer between 1 and 65535.`);
  }

  return value;
}

function readRequiredEnvString(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required when it is not set in nuntius.toml.`);
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
