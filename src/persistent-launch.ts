import { spawn } from "node:child_process";
import process from "node:process";

export const NUNTIUS_LAUNCH_MODE_ENV_KEY = "NUNTIUS_LAUNCH_MODE";
export const NUNTIUS_PERSISTENT_LAUNCHED_ENV_KEY = "NUNTIUS_PERSISTENT_LAUNCHED";
export const NUNTIUS_SYSTEMD_RUN_BINARY_ENV_KEY = "NUNTIUS_SYSTEMD_RUN_BINARY";

export type NuntiusLaunchMode = "direct" | "systemd-run";

interface PersistentLaunchOptions {
  label: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  cwd?: string;
  systemdRunBinary?: string;
}

export function resolveLaunchMode(env: NodeJS.ProcessEnv = process.env): NuntiusLaunchMode {
  const raw = env[NUNTIUS_LAUNCH_MODE_ENV_KEY];

  if (!raw || raw === "direct") {
    return "direct";
  }

  if (raw === "systemd-run") {
    return "systemd-run";
  }

  throw new Error(
    `${NUNTIUS_LAUNCH_MODE_ENV_KEY} must be "direct" or "systemd-run" when set.`
  );
}

export function shouldRelaunchPersistently(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    resolveLaunchMode(env) === "systemd-run" &&
    env[NUNTIUS_PERSISTENT_LAUNCHED_ENV_KEY] !== "1"
  );
}

export async function maybeRelaunchCurrentProcessPersistently(
  options: PersistentLaunchOptions
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!shouldRelaunchPersistently(env)) {
    return false;
  }

  const argv = options.argv ?? process.argv.slice(1);
  if (argv.length === 0) {
    throw new Error("Cannot relaunch persistently without a current script path.");
  }

  const unitName = buildPersistentUnitName(options.label);
  const systemdRunBinary =
    options.systemdRunBinary ??
    env[NUNTIUS_SYSTEMD_RUN_BINARY_ENV_KEY] ??
    "systemd-run";
  const nextEnv = {
    ...env,
    [NUNTIUS_LAUNCH_MODE_ENV_KEY]: "direct",
    [NUNTIUS_PERSISTENT_LAUNCHED_ENV_KEY]: "1"
  };
  const args = buildSystemdRunArgs({
    label: options.label,
    unitName,
    cwd: options.cwd ?? process.cwd(),
    env: nextEnv,
    command: [process.execPath, ...argv]
  });
  const result = await runCommand(systemdRunBinary, args, env);

  if (result.code !== 0) {
    const details = result.stderr || result.stdout || "No stderr output.";
    throw new Error(
      [
        `Failed to launch ${options.label} persistently via systemd-run.`,
        "This host likely blocks transient user services in the current runtime.",
        "Run nuntius from an external terminal or supervisor instead.",
        details
      ].join("\n")
    );
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (output) {
    console.log(output);
  }
  console.log(
    `Launched ${options.label} persistently via systemd-run unit ${unitName}.`
  );

  return true;
}

export function buildSystemdRunArgs(input: {
  label: string;
  unitName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  command: string[];
}): string[] {
  return [
    "--user",
    "--collect",
    "--no-block",
    "--service-type=exec",
    "--working-directory",
    input.cwd,
    "--unit",
    input.unitName,
    `--description=${input.label}`,
    ...buildSystemdRunEnvArgs(input.env),
    "--",
    ...input.command
  ];
}

function buildSystemdRunEnvArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .sort()
    .flatMap((key) => {
      const value = env[key];
      if (value === undefined) {
        return [];
      }

      return [`--setenv=${key}=${value}`];
    });
}

function buildPersistentUnitName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "nuntius";

  return `nuntius-${slug}-${process.pid}-${Date.now()}`;
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    env,
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
    child.once("error", (error) => {
      reject(
        new Error(
          `Failed to execute ${command}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    });

    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}
