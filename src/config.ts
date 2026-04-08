import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { parse as parseToml } from "smol-toml";

import {
  isRecord,
  loadNuntiusConfigFile,
  readArray,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  readTable,
  resolveConfigRelativePath,
  type LoadedConfigFile
} from "./config-file.js";
import type { ApprovalPolicy, SandboxMode } from "./domain.js";

export type ProgressUpdateMode = "off" | "minimal" | "latest" | "verbose";

export interface RepositoryTarget {
  id: string;
  path: string;
  sandboxMode: SandboxMode;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  codexConfigOverrides?: string[];
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
  allowUsers?: string[];
  allowChannels?: string[];
}

export interface BridgeConfig {
  codexBinary: string;
  yoloMode?: boolean;
  defaultRepositoryId: string;
  requireExplicitRepositorySelection: boolean;
  handlerWorkspacePath: string;
  handlerSandboxMode: SandboxMode;
  handlerModel?: string;
  maxHandlerStepsPerTurn: number;
  progressUpdates: ProgressUpdateMode;
  repositoryRegistryPath?: string;
  repositoryTargets: RepositoryTarget[];
  sessionStorePath: string;
  maxResponseChars: number;
  configFilePath?: string;
}

export function loadConfig(): BridgeConfig {
  const loadedConfigFile = loadNuntiusConfigFile();
  const bridgeTable = loadedConfigFile ? readTable(loadedConfigFile.document, "bridge") : undefined;
  const bridgeRecord = bridgeTable ?? {};

  const repositoryRegistryPath =
    resolveConfigRelativePath(loadedConfigFile, readString(bridgeRecord, "repository_registry_path")) ??
    readOptionalEnvString(process.env.NUNTIUS_REPOSITORY_REGISTRY_PATH);

  const registry = loadRepositoryRegistry({
    loadedConfigFile,
    repositoryRegistryPath,
    inlineRepositoryTargets:
      (loadedConfigFile && readArray(loadedConfigFile.document, "repository_targets")) ??
      (loadedConfigFile && readArray(loadedConfigFile.document, "repositories")),
    fileDefaultRepositoryId: readString(bridgeRecord, "default_repository_id"),
    envRepositories: process.env.NUNTIUS_REPOSITORIES,
    envDefaultRepositoryId: process.env.NUNTIUS_DEFAULT_REPOSITORY_ID
  });

  if (registry.repositoryTargets.length === 0) {
    throw new Error("At least one repository target must be configured.");
  }

  return {
    codexBinary: readString(bridgeRecord, "codex_binary") ?? process.env.NUNTIUS_CODEX_BINARY ?? "codex",
    yoloMode:
      readBoolean(bridgeRecord, "yolo_mode") ?? parseBooleanEnv(process.env.NUNTIUS_YOLO_MODE, true),
    defaultRepositoryId: registry.defaultRepositoryId,
    requireExplicitRepositorySelection:
      readBoolean(bridgeRecord, "require_explicit_repository_selection") ??
      parseBooleanEnv(process.env.NUNTIUS_REQUIRE_EXPLICIT_REPOSITORY_SELECTION, true),
    handlerWorkspacePath:
      resolveConfigRelativePath(loadedConfigFile, readString(bridgeRecord, "handler_workspace_path")) ??
      process.env.NUNTIUS_HANDLER_WORKSPACE_PATH ??
      process.cwd(),
    handlerSandboxMode: parseSandboxMode(
      readString(bridgeRecord, "handler_sandbox_mode") ??
        process.env.NUNTIUS_HANDLER_SANDBOX_MODE ??
        "danger-full-access"
    ),
    handlerModel: readString(bridgeRecord, "handler_model") ?? readOptionalEnvString(process.env.NUNTIUS_HANDLER_MODEL),
    maxHandlerStepsPerTurn:
      readPositiveInteger(bridgeRecord, "max_handler_steps_per_turn") ??
      parsePositiveIntEnv(process.env.NUNTIUS_MAX_HANDLER_STEPS_PER_TURN, 4),
    progressUpdates: parseProgressUpdateMode(
      readString(bridgeRecord, "progress_updates") ??
        process.env.NUNTIUS_PROGRESS_UPDATES ??
        "minimal"
    ),
    repositoryRegistryPath,
    repositoryTargets: registry.repositoryTargets,
    sessionStorePath:
      resolveConfigRelativePath(loadedConfigFile, readString(bridgeRecord, "session_store_path")) ??
      process.env.NUNTIUS_SESSION_STORE_PATH ??
      ".nuntius/sessions.json",
    maxResponseChars:
      readPositiveInteger(bridgeRecord, "max_response_chars") ??
      parsePositiveIntEnv(process.env.NUNTIUS_MAX_RESPONSE_CHARS, 3500),
    configFilePath: loadedConfigFile?.path
  };
}

export function loadRepositoryRegistry(input: {
  loadedConfigFile?: LoadedConfigFile;
  repositoryRegistryPath?: string;
  inlineRepositoryTargets?: unknown[];
  fileDefaultRepositoryId?: string;
  envRepositories?: string;
  envDefaultRepositoryId?: string;
}): {
  defaultRepositoryId: string;
  repositoryTargets: RepositoryTarget[];
} {
  if (input.repositoryRegistryPath) {
    return parseRepositoryRegistryDocument(
      readFileSync(input.repositoryRegistryPath, "utf8"),
      input.repositoryRegistryPath
    );
  }

  if (input.inlineRepositoryTargets) {
    const repositoryTargets = input.inlineRepositoryTargets.map((target) =>
      parseRepositoryTarget(target, {
        baseDir: input.loadedConfigFile?.dir
      })
    );

    return {
      defaultRepositoryId:
        input.fileDefaultRepositoryId ??
        input.envDefaultRepositoryId ??
        repositoryTargets[0]?.id ??
        "default",
      repositoryTargets
    };
  }

  const repositoryTargets = parseRepositoryTargets(input.envRepositories);
  return {
    defaultRepositoryId:
      input.fileDefaultRepositoryId ??
      input.envDefaultRepositoryId ??
      repositoryTargets[0]?.id ??
      "default",
    repositoryTargets
  };
}

function parseRepositoryTargets(raw: string | undefined): RepositoryTarget[] {
  if (!raw) {
    return [
      {
        id: "default",
        path: process.cwd(),
        sandboxMode: "danger-full-access"
      }
    ];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("NUNTIUS_REPOSITORIES must be a JSON array.");
  }

  return parsed.map((target) => parseRepositoryTarget(target));
}

function parseRepositoryRegistryDocument(
  raw: string,
  sourceDescription: string
): {
  defaultRepositoryId: string;
  repositoryTargets: RepositoryTarget[];
} {
  const parsed = parseDataDocument(raw, sourceDescription);

  if (Array.isArray(parsed)) {
    const repositoryTargets = parsed.map((target) =>
      parseRepositoryTarget(target, {
        baseDir: path.dirname(sourceDescription)
      })
    );
    return {
      defaultRepositoryId: repositoryTargets[0]?.id ?? "default",
      repositoryTargets
    };
  }

  if (!isRecord(parsed)) {
    throw new Error(`Repository registry in ${sourceDescription} must be an object or array.`);
  }

  const repositoryTargetsRaw =
    readArray(parsed, "repository_targets") ?? readArray(parsed, "repositories");
  if (!repositoryTargetsRaw) {
    throw new Error(`repository_targets in ${sourceDescription} must be an array.`);
  }

  const repositoryTargets = repositoryTargetsRaw.map((target) =>
    parseRepositoryTarget(target, {
      baseDir: path.dirname(sourceDescription)
    })
  );
  const defaultRepositoryId =
    readString(parsed, "default_repository_id") ??
    readString(parsed, "defaultRepositoryId") ??
    repositoryTargets[0]?.id ??
    "default";

  return {
    defaultRepositoryId,
    repositoryTargets
  };
}

function parseRepositoryTarget(
  value: unknown,
  options?: {
    baseDir?: string;
  }
): RepositoryTarget {
  if (!isRecord(value)) {
    throw new Error("Each repository target must be an object.");
  }

  const id = readStringFromKeys(value, ["id"]);
  const rawPath = readStringFromKeys(value, ["path"]);
  const sandboxMode = parseSandboxMode(readStringFromKeys(value, ["sandbox_mode", "sandboxMode"]));
  const model = readOptionalStringFromKeys(value, ["model"]);
  const approvalPolicy = readOptionalApprovalPolicyFromKeys(value, [
    "approval_policy",
    "approvalPolicy"
  ]);
  const codexConfigOverrides = readOptionalStringArrayFromKeys(value, [
    "codex_config_overrides",
    "codexConfigOverrides"
  ]);
  const allowCodexNetworkAccessSetting = readOptionalBooleanFromKeys(value, [
    "allow_codex_network_access",
    "allowCodexNetworkAccess",
    "allow_external_repository_access",
    "allowExternalRepositoryAccess"
  ]);
  const explicitCodexNetworkAccessWorkspacePath = resolveOptionalPath(
    readOptionalStringFromKeys(value, [
      "codex_network_access_workspace_path",
      "codexNetworkAccessWorkspacePath",
      "external_repository_workspace_path",
      "externalRepositoryWorkspacePath"
    ]),
    options?.baseDir
  );
  const allowUsers = readOptionalStringArrayFromKeys(value, ["allow_users", "allowUsers"]);
  const allowChannels = readOptionalStringArrayFromKeys(value, ["allow_channels", "allowChannels"]);
  const allowCodexNetworkAccess = allowCodexNetworkAccessSetting ?? true;
  const codexNetworkAccessWorkspacePath = allowCodexNetworkAccess
    ? explicitCodexNetworkAccessWorkspacePath ?? deriveDefaultCodexNetworkAccessWorkspacePath(id)
    : explicitCodexNetworkAccessWorkspacePath;

  if (!allowCodexNetworkAccess && explicitCodexNetworkAccessWorkspacePath) {
    throw new Error(
      "codexNetworkAccessWorkspacePath requires allowCodexNetworkAccess to be true."
    );
  }

  if (codexConfigOverrides?.some((override) => override.trim().length === 0)) {
    throw new Error("codexConfigOverrides must not contain empty strings.");
  }

  return {
    id,
    path: resolvePath(rawPath, options?.baseDir),
    sandboxMode,
    model,
    approvalPolicy,
    codexConfigOverrides,
    allowCodexNetworkAccess,
    codexNetworkAccessWorkspacePath,
    allowUsers,
    allowChannels
  };
}

function deriveDefaultCodexNetworkAccessWorkspacePath(repositoryId: string): string {
  return path.join(os.tmpdir(), "nuntius-codex-network", sanitizePathComponent(repositoryId));
}

function sanitizePathComponent(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "repository";
}

function parseDataDocument(raw: string, sourceDescription: string): unknown {
  const extension = path.extname(sourceDescription).toLowerCase();

  if (extension === ".toml") {
    return parseToml(raw);
  }

  if (extension === ".json") {
    return JSON.parse(raw) as unknown;
  }

  try {
    return parseToml(raw);
  } catch {
    return JSON.parse(raw) as unknown;
  }
}

function parseSandboxMode(value: unknown): SandboxMode {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }

  throw new Error(
    "sandboxMode must be one of read-only, workspace-write, or danger-full-access."
  );
}

function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (
    value === "untrusted" ||
    value === "on-failure" ||
    value === "on-request" ||
    value === "never"
  ) {
    return value;
  }

  throw new Error(
    "approvalPolicy must be one of untrusted, on-failure, on-request, or never."
  );
}

function parseProgressUpdateMode(value: unknown): ProgressUpdateMode {
  if (value === "off" || value === "minimal" || value === "latest" || value === "verbose") {
    return value;
  }

  throw new Error("progress_updates must be one of off, minimal, latest, or verbose.");
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive integer but received ${raw}.`);
  }

  return value;
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

function readPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(record, key);
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected ${key} to be a positive integer.`);
  }

  return value;
}

function readOptionalEnvString(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }

  return raw;
}

function readStringFromKeys(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined) {
      return value;
    }
  }

  throw new Error(`Expected one of ${keys.join(", ")} to be a non-empty string.`);
}

function readOptionalStringFromKeys(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readOptionalStringArrayFromKeys(
  record: Record<string, unknown>,
  keys: string[]
): string[] | undefined {
  for (const key of keys) {
    const value = readStringArray(record, key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readOptionalBooleanFromKeys(
  record: Record<string, unknown>,
  keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = readBoolean(record, key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readOptionalApprovalPolicyFromKeys(
  record: Record<string, unknown>,
  keys: string[]
): ApprovalPolicy | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined) {
      return parseApprovalPolicy(value);
    }
  }

  return undefined;
}

function resolvePath(rawPath: string, baseDir?: string): string {
  if (!baseDir || path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.resolve(baseDir, rawPath);
}

function resolveOptionalPath(rawPath: string | undefined, baseDir?: string): string | undefined {
  if (!rawPath) {
    return undefined;
  }

  return resolvePath(rawPath, baseDir);
}
