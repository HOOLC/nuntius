import process from "node:process";

import {
  loadNuntiusConfigFile,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  readTable
} from "./config-file.js";

export interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  host: string;
  port: number;
  eventsPath: string;
  healthPath: string;
  allowedOpenIds: string[];
  adminOpenIds: string[];
  allowProcessRestart: boolean;
  apiBaseUrl: string;
  configFilePath?: string;
}

export function loadFeishuBotConfig(): FeishuBotConfig {
  const loadedConfigFile = loadNuntiusConfigFile();
  const feishuTable = loadedConfigFile ? readTable(loadedConfigFile.document, "feishu") : undefined;
  const feishuRecord = feishuTable ?? {};

  return {
    appId: readString(feishuRecord, "app_id") ?? readRequiredEnvString("NUNTIUS_FEISHU_APP_ID"),
    appSecret:
      readString(feishuRecord, "app_secret") ?? readRequiredEnvString("NUNTIUS_FEISHU_APP_SECRET"),
    verificationToken:
      readString(feishuRecord, "verification_token") ??
      readOptionalEnvString("NUNTIUS_FEISHU_VERIFICATION_TOKEN"),
    encryptKey:
      readString(feishuRecord, "encrypt_key") ??
      readOptionalEnvString("NUNTIUS_FEISHU_ENCRYPT_KEY"),
    host: readString(feishuRecord, "host") ?? process.env.NUNTIUS_FEISHU_HOST ?? "0.0.0.0",
    port: parsePort(
      readNumber(feishuRecord, "port"),
      process.env.NUNTIUS_FEISHU_PORT
    ),
    eventsPath:
      readString(feishuRecord, "events_path") ??
      process.env.NUNTIUS_FEISHU_EVENTS_PATH ??
      "/feishu/events",
    healthPath:
      readString(feishuRecord, "health_path") ??
      process.env.NUNTIUS_FEISHU_HEALTH_PATH ??
      "/healthz",
    allowedOpenIds:
      readStringArray(feishuRecord, "allowed_open_ids") ??
      readStringArray(feishuRecord, "allowed_user_ids") ??
      parseCsvEnv(process.env.NUNTIUS_FEISHU_ALLOWED_OPEN_IDS ?? process.env.NUNTIUS_FEISHU_ALLOWED_USER_IDS),
    adminOpenIds:
      readStringArray(feishuRecord, "admin_open_ids") ??
      readStringArray(feishuRecord, "admin_user_ids") ??
      parseCsvEnv(process.env.NUNTIUS_FEISHU_ADMIN_OPEN_IDS ?? process.env.NUNTIUS_FEISHU_ADMIN_USER_IDS),
    allowProcessRestart:
      readBoolean(feishuRecord, "allow_process_restart") ??
      parseBooleanEnv(process.env.NUNTIUS_FEISHU_ALLOW_PROCESS_RESTART, false),
    apiBaseUrl:
      readString(feishuRecord, "api_base_url") ??
      process.env.NUNTIUS_FEISHU_API_BASE_URL ??
      "https://open.feishu.cn/open-apis",
    configFilePath: loadedConfigFile?.path
  };
}

function parsePort(fileValue: number | undefined, envValue: string | undefined): number {
  if (fileValue !== undefined) {
    return ensurePort(fileValue, "feishu.port");
  }

  if (!envValue) {
    return 8789;
  }

  return ensurePort(Number.parseInt(envValue, 10), "NUNTIUS_FEISHU_PORT");
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
