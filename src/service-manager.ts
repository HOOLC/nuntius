import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export type ManagedIntegration = "all" | "discord" | "feishu" | "slack";
export type ServicePlatform = "darwin" | "linux";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ServiceCommandRunner = (
  command: string,
  args: string[],
  options?: {
    allowFailure?: boolean;
  }
) => Promise<CommandResult>;

export interface ServiceDefinitionOptions {
  platform?: NodeJS.Platform | ServicePlatform;
  serviceName?: string;
  integration?: ManagedIntegration;
  workingDirectory?: string;
  nodePath?: string;
  scriptPath?: string;
  configPath?: string;
  homeDir?: string;
  logDir?: string;
  uid?: number;
  env?: Record<string, string>;
}

export interface ServiceActionOptions extends ServiceDefinitionOptions {
  runCommand?: ServiceCommandRunner;
  launchdBootstrapRetries?: number;
  launchdBootstrapRetryDelayMs?: number;
}

export interface ManagedServiceDefinition {
  platform: ServicePlatform;
  serviceName: string;
  integration: ManagedIntegration;
  description: string;
  nodePath: string;
  scriptPath: string;
  workingDirectory: string;
  configPath?: string;
  env: Record<string, string>;
  launchd?: {
    label: string;
    domain: string;
    target: string;
    plistPath: string;
    logDir: string;
    stdoutPath: string;
    stderrPath: string;
  };
  systemd?: {
    unitName: string;
    unitPath: string;
  };
}

export interface LogsCommandOptions extends ServiceDefinitionOptions {
  follow?: boolean;
  lines?: number;
}

const DEFAULT_SERVICE_NAME = "nuntius";
const DEFAULT_LOG_LINES = 200;
const DEFAULT_LAUNCHD_BOOTSTRAP_RETRIES = 5;
const DEFAULT_LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS = 1_000;
const DEFAULT_LAUNCHD_LOAD_CHECKS = 5;

export function buildManagedServiceDefinition(
  options: ServiceDefinitionOptions = {}
): ManagedServiceDefinition {
  const platform = resolveServicePlatform(options.platform ?? process.platform);
  const serviceName = normalizeServiceName(options.serviceName ?? DEFAULT_SERVICE_NAME);
  const integration = options.integration ?? "all";
  const homeDir = options.homeDir ?? os.homedir();
  const workingDirectory = path.resolve(options.workingDirectory ?? process.cwd());
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  const scriptPath = path.resolve(options.scriptPath ?? defaultScriptPath(integration));
  const configPath = resolveConfigPath(options.configPath, workingDirectory);
  const env = buildServiceEnvironment({
    extraEnv: options.env,
    configPath,
    nodePath
  });
  const description = buildDescription(integration);

  const baseDefinition = {
    platform,
    serviceName,
    integration,
    description,
    nodePath,
    scriptPath,
    workingDirectory,
    configPath,
    env
  };

  if (platform === "darwin") {
    const label = buildLaunchdLabel(serviceName);
    const domain = `gui/${resolveUid(options.uid)}`;
    const logDir = path.resolve(options.logDir ?? path.join(homeDir, "Library", "Logs", "nuntius"));
    const logBaseName = sanitizeFileName(serviceName);

    return {
      ...baseDefinition,
      launchd: {
        label,
        domain,
        target: `${domain}/${label}`,
        plistPath: path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`),
        logDir,
        stdoutPath: path.join(logDir, `${logBaseName}.out.log`),
        stderrPath: path.join(logDir, `${logBaseName}.err.log`)
      }
    };
  }

  const unitBaseName = sanitizeFileName(serviceName);
  const unitName = `${unitBaseName}.service`;
  return {
    ...baseDefinition,
    systemd: {
      unitName,
      unitPath: path.join(homeDir, ".config", "systemd", "user", unitName)
    }
  };
}

export async function installManagedService(
  options: ServiceActionOptions = {}
): Promise<ManagedServiceDefinition> {
  const definition = buildManagedServiceDefinition(options);
  const runCommand = options.runCommand ?? runCommandCapturingOutput;

  if (definition.platform === "darwin") {
    const launchd = requireLaunchd(definition);
    mkdirSync(path.dirname(launchd.plistPath), { recursive: true });
    mkdirSync(launchd.logDir, { recursive: true });
    writeFileSync(launchd.plistPath, buildLaunchdPlist(definition), { mode: 0o644 });
    return definition;
  }

  const systemd = requireSystemd(definition);
  mkdirSync(path.dirname(systemd.unitPath), { recursive: true });
  writeFileSync(systemd.unitPath, buildSystemdUnit(definition), { mode: 0o644 });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", systemd.unitName]);
  return definition;
}

export async function uninstallManagedService(
  options: ServiceActionOptions = {}
): Promise<ManagedServiceDefinition> {
  const definition = buildManagedServiceDefinition(options);
  const runCommand = options.runCommand ?? runCommandCapturingOutput;

  if (definition.platform === "darwin") {
    const launchd = requireLaunchd(definition);
    await runCommand("launchctl", ["bootout", launchd.target], { allowFailure: true });
    rmSync(launchd.plistPath, { force: true });
    return definition;
  }

  const systemd = requireSystemd(definition);
  await runCommand("systemctl", ["--user", "disable", "--now", systemd.unitName], {
    allowFailure: true
  });
  rmSync(systemd.unitPath, { force: true });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  return definition;
}

export async function startManagedService(
  options: ServiceActionOptions = {}
): Promise<ManagedServiceDefinition> {
  const definition = buildManagedServiceDefinition(options);
  const runCommand = options.runCommand ?? runCommandCapturingOutput;

  if (definition.platform === "darwin") {
    const launchd = requireLaunchd(definition);
    if (!existsSync(launchd.plistPath)) {
      throw new Error(`LaunchAgent plist is not installed: ${launchd.plistPath}`);
    }
    await bootstrapLaunchdService(runCommand, launchd, options);
    await runCommand("launchctl", ["kickstart", "-k", launchd.target]);
    return definition;
  }

  const systemd = requireSystemd(definition);
  await runCommand("systemctl", ["--user", "start", systemd.unitName]);
  return definition;
}

export async function stopManagedService(
  options: ServiceActionOptions = {}
): Promise<ManagedServiceDefinition> {
  const definition = buildManagedServiceDefinition(options);
  const runCommand = options.runCommand ?? runCommandCapturingOutput;

  if (definition.platform === "darwin") {
    const launchd = requireLaunchd(definition);
    await runCommand("launchctl", ["bootout", launchd.target], { allowFailure: true });
    return definition;
  }

  const systemd = requireSystemd(definition);
  await runCommand("systemctl", ["--user", "stop", systemd.unitName], { allowFailure: true });
  return definition;
}

export async function restartManagedService(
  options: ServiceActionOptions = {}
): Promise<ManagedServiceDefinition> {
  const definition = buildManagedServiceDefinition(options);
  const runCommand = options.runCommand ?? runCommandCapturingOutput;

  if (definition.platform === "darwin") {
    const launchd = requireLaunchd(definition);
    if (await isLaunchdServiceLoaded(runCommand, launchd)) {
      await runCommand("launchctl", ["kickstart", "-k", launchd.target]);
      return definition;
    }

    await bootstrapLaunchdService(runCommand, launchd, options);
    return definition;
  }

  const systemd = requireSystemd(definition);
  await runCommand("systemctl", ["--user", "restart", systemd.unitName]);
  return definition;
}

export async function statusManagedService(
  options: ServiceActionOptions = {}
): Promise<CommandResult> {
  const definition = buildManagedServiceDefinition(options);
  const runCommand = options.runCommand ?? runCommandCapturingOutput;

  if (definition.platform === "darwin") {
    const launchd = requireLaunchd(definition);
    return await runCommand("launchctl", ["print", launchd.target], { allowFailure: true });
  }

  const systemd = requireSystemd(definition);
  return await runCommand("systemctl", ["--user", "status", "--no-pager", systemd.unitName], {
    allowFailure: true
  });
}

export function buildLogsCommand(options: LogsCommandOptions = {}): {
  command: string;
  args: string[];
} {
  const definition = buildManagedServiceDefinition(options);
  const lines = String(readPositiveInteger(options.lines, DEFAULT_LOG_LINES));

  if (definition.platform === "darwin") {
    const launchd = requireLaunchd(definition);
    return {
      command: "tail",
      args: ["-n", lines, ...(options.follow ? ["-f"] : []), launchd.stdoutPath, launchd.stderrPath]
    };
  }

  const systemd = requireSystemd(definition);
  return {
    command: "journalctl",
    args: ["--user", "-u", systemd.unitName, "-n", lines, ...(options.follow ? ["-f"] : [])]
  };
}

export function buildLaunchdPlist(definition: ManagedServiceDefinition): string {
  const launchd = requireLaunchd(definition);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    plistKeyString("Label", launchd.label),
    plistKeyArray("ProgramArguments", [definition.nodePath, definition.scriptPath]),
    plistKeyString("WorkingDirectory", definition.workingDirectory),
    plistKeyDict("EnvironmentVariables", definition.env),
    plistKeyBoolean("RunAtLoad", true),
    plistKeyBoolean("KeepAlive", true),
    plistKeyString("StandardOutPath", launchd.stdoutPath),
    plistKeyString("StandardErrorPath", launchd.stderrPath),
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

export function buildSystemdUnit(definition: ManagedServiceDefinition): string {
  const systemd = requireSystemd(definition);
  return [
    "[Unit]",
    `Description=${definition.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapeSystemdValue(definition.workingDirectory)}`,
    `ExecStart=${buildSystemdCommandLine([definition.nodePath, definition.scriptPath])}`,
    ...Object.entries(definition.env)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `Environment=${escapeSystemdValue(`${key}=${value}`)}`),
    "Restart=always",
    "RestartSec=3",
    "KillSignal=SIGTERM",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export async function runCommandCapturingOutput(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
  } = {}
): Promise<CommandResult> {
  const result = await spawnAndCapture(command, args);
  if (result.code !== 0 && !options.allowFailure) {
    const detail = result.stderr || result.stdout || `exit code ${result.code}`;
    throw new Error(`${command} ${args.join(" ")} failed:\n${detail}`);
  }
  return result;
}

function resolveServicePlatform(platform: NodeJS.Platform | ServicePlatform): ServicePlatform {
  if (platform === "darwin" || platform === "linux") {
    return platform;
  }

  throw new Error(`Managed bot services are supported on macOS launchd and Linux systemd, not ${platform}.`);
}

function defaultScriptPath(integration: ManagedIntegration): string {
  switch (integration) {
    case "all":
      return fileURLToPath(new URL("./index.js", import.meta.url));
    case "discord":
      return fileURLToPath(new URL("./discord-bot.js", import.meta.url));
    case "feishu":
      return fileURLToPath(new URL("./feishu-bot.js", import.meta.url));
    case "slack":
      return fileURLToPath(new URL("./slack-bot.js", import.meta.url));
  }
}

function resolveConfigPath(configPath: string | undefined, workingDirectory: string): string | undefined {
  const configuredPath = configPath ?? process.env.NUNTIUS_CONFIG_PATH;
  if (configuredPath) {
    return path.resolve(workingDirectory, configuredPath);
  }

  const localConfigPath = path.join(workingDirectory, "nuntius.toml");
  return existsSync(localConfigPath) ? localConfigPath : undefined;
}

function buildServiceEnvironment(input: {
  extraEnv?: Record<string, string>;
  configPath?: string;
  nodePath: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: buildDefaultServicePath(input.nodePath)
  };

  if (input.configPath) {
    env.NUNTIUS_CONFIG_PATH = input.configPath;
  }

  for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
    if (!isEnvironmentKey(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    env[key] = value;
  }

  return env;
}

function buildDefaultServicePath(nodePath: string): string {
  return [
    path.dirname(nodePath),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(":");
}

function buildDescription(integration: ManagedIntegration): string {
  if (integration === "all") {
    return "nuntius IM bridge";
  }

  return `nuntius ${integration} bridge`;
}

function normalizeServiceName(serviceName: string): string {
  const normalized = serviceName.trim();
  if (!normalized) {
    throw new Error("Service name must not be empty.");
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Service name may contain only letters, numbers, dot, underscore, and dash.");
  }

  return normalized;
}

function buildLaunchdLabel(serviceName: string): string {
  return serviceName.includes(".") ? serviceName : `com.hoolc.${serviceName}`;
}

function sanitizeFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || DEFAULT_SERVICE_NAME;
}

function resolveUid(uid: number | undefined): number {
  if (uid !== undefined) {
    return uid;
  }

  if (typeof process.getuid === "function") {
    return process.getuid();
  }

  const rawUid = process.env.UID;
  const parsedUid = rawUid ? Number(rawUid) : NaN;
  if (Number.isInteger(parsedUid) && parsedUid >= 0) {
    return parsedUid;
  }

  throw new Error("Could not resolve the current user id for launchd.");
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Expected a positive integer.");
  }

  return value;
}

function isEnvironmentKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function requireLaunchd(definition: ManagedServiceDefinition): NonNullable<ManagedServiceDefinition["launchd"]> {
  if (!definition.launchd) {
    throw new Error("This service definition is not for launchd.");
  }

  return definition.launchd;
}

function requireSystemd(definition: ManagedServiceDefinition): NonNullable<ManagedServiceDefinition["systemd"]> {
  if (!definition.systemd) {
    throw new Error("This service definition is not for systemd.");
  }

  return definition.systemd;
}

async function bootstrapLaunchdService(
  runCommand: ServiceCommandRunner,
  launchd: NonNullable<ManagedServiceDefinition["launchd"]>,
  options: Pick<ServiceActionOptions, "launchdBootstrapRetries" | "launchdBootstrapRetryDelayMs">
): Promise<void> {
  const args = ["bootstrap", launchd.domain, launchd.plistPath];
  const maxAttempts = Math.max(
    1,
    options.launchdBootstrapRetries ?? DEFAULT_LAUNCHD_BOOTSTRAP_RETRIES
  );
  const delayMs = Math.max(
    0,
    options.launchdBootstrapRetryDelayMs ?? DEFAULT_LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS
  );
  let lastResult: CommandResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runCommand("launchctl", args, { allowFailure: true });
    if (result.code === 0) {
      if (await waitForLaunchdServiceLoaded(runCommand, launchd, delayMs)) {
        return;
      }

      lastResult = {
        code: 37,
        stdout: "",
        stderr: `launchctl bootstrap returned success, but ${launchd.target} was not visible in launchd.`
      };
      continue;
    }

    lastResult = result;
    if (await isLaunchdServiceLoaded(runCommand, launchd)) {
      return;
    }

    if (!isRetriableLaunchdBootstrapFailure(result) || attempt === maxAttempts) {
      break;
    }

    await delay(delayMs);
  }

  throw new Error(formatCommandFailure("launchctl", args, lastResult));
}

async function isLaunchdServiceLoaded(
  runCommand: ServiceCommandRunner,
  launchd: NonNullable<ManagedServiceDefinition["launchd"]>
): Promise<boolean> {
  const result = await runCommand("launchctl", ["print", launchd.target], {
    allowFailure: true
  });
  return result.code === 0;
}

async function waitForLaunchdServiceLoaded(
  runCommand: ServiceCommandRunner,
  launchd: NonNullable<ManagedServiceDefinition["launchd"]>,
  delayMs: number
): Promise<boolean> {
  for (let attempt = 1; attempt <= DEFAULT_LAUNCHD_LOAD_CHECKS; attempt += 1) {
    if (await isLaunchdServiceLoaded(runCommand, launchd)) {
      return true;
    }

    if (attempt < DEFAULT_LAUNCHD_LOAD_CHECKS) {
      await delay(delayMs);
    }
  }

  return false;
}

function isRetriableLaunchdBootstrapFailure(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return result.code === 5 || /Bootstrap failed:\s*5|Input\/output error/i.test(output);
}

function formatCommandFailure(
  command: string,
  args: string[],
  result: CommandResult | undefined
): string {
  const detail = result
    ? result.stderr || result.stdout || `exit code ${result.code}`
    : "unknown failure";
  return `${command} ${args.join(" ")} failed:\n${detail}`;
}

function plistKeyString(key: string, value: string): string {
  return `  <key>${escapeXml(key)}</key>\n  <string>${escapeXml(value)}</string>`;
}

function plistKeyBoolean(key: string, value: boolean): string {
  return `  <key>${escapeXml(key)}</key>\n  <${value ? "true" : "false"}/>`;
}

function plistKeyArray(key: string, values: string[]): string {
  const body = values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  return `  <key>${escapeXml(key)}</key>\n  <array>\n${body}\n  </array>`;
}

function plistKeyDict(key: string, values: Record<string, string>): string {
  const body = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, value]) => `    <key>${escapeXml(entryKey)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `  <key>${escapeXml(key)}</key>\n  <dict>\n${body}\n  </dict>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSystemdCommandLine(args: string[]): string {
  return args.map(escapeSystemdValue).join(" ");
}

function escapeSystemdValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function spawnAndCapture(command: string, args: string[]): Promise<CommandResult> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
