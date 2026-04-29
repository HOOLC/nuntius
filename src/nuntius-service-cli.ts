#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

import {
  buildLaunchdPlist,
  buildLogsCommand,
  buildManagedServiceDefinition,
  buildSystemdUnit,
  installManagedService,
  restartManagedService,
  startManagedService,
  statusManagedService,
  stopManagedService,
  uninstallManagedService,
  type ManagedIntegration,
  type ServiceDefinitionOptions,
  type ServicePlatform
} from "./service-manager.js";

type ServiceCliCommand =
  | "help"
  | "install"
  | "logs"
  | "print"
  | "restart"
  | "start"
  | "status"
  | "stop"
  | "uninstall";

interface ParsedArgs extends ServiceDefinitionOptions {
  command: ServiceCliCommand;
  startAfterInstall: boolean;
  followLogs: boolean;
  logLines?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printHelp();
    return;
  }

  switch (args.command) {
    case "install": {
      const definition = await installManagedService(args);
      printInstalled(definition);
      if (args.startAfterInstall) {
        await restartManagedService(args);
        console.log("Started service.");
      }
      return;
    }
    case "uninstall": {
      const definition = await uninstallManagedService(args);
      console.log(`Uninstalled ${renderServiceId(definition)}.`);
      return;
    }
    case "start": {
      const definition = await startManagedService(args);
      console.log(`Started ${renderServiceId(definition)}.`);
      return;
    }
    case "stop": {
      const definition = await stopManagedService(args);
      console.log(`Stopped ${renderServiceId(definition)}.`);
      return;
    }
    case "restart": {
      const definition = await restartManagedService(args);
      console.log(`Restarted ${renderServiceId(definition)}.`);
      return;
    }
    case "status": {
      const result = await statusManagedService(args);
      writeCommandOutput(result.stdout, result.stderr);
      process.exitCode = result.code;
      return;
    }
    case "logs": {
      const logsCommand = buildLogsCommand({
        ...args,
        follow: args.followLogs,
        lines: args.logLines
      });
      process.exitCode = await runForeground(logsCommand.command, logsCommand.args);
      return;
    }
    case "print": {
      const definition = buildManagedServiceDefinition(args);
      console.log(definition.platform === "darwin" ? buildLaunchdPlist(definition) : buildSystemdUnit(definition));
      return;
    }
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const command = parseCommand(args[0]);
  const parsed: ParsedArgs = {
    command,
    startAfterInstall: false,
    followLogs: false
  };

  const startIndex = command === "help" && args[0] !== "help" && args[0] !== "--help" && args[0] !== "-h" ? 0 : 1;
  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--config":
        parsed.configPath = requireValue(arg, next);
        index += 1;
        break;
      case "--cwd":
      case "--working-directory":
        parsed.workingDirectory = requireValue(arg, next);
        index += 1;
        break;
      case "--env": {
        const assignment = requireValue(arg, next);
        parsed.env = {
          ...(parsed.env ?? {}),
          ...parseEnvAssignment(assignment)
        };
        index += 1;
        break;
      }
      case "--follow":
      case "-f":
        parsed.followLogs = true;
        break;
      case "--help":
      case "-h":
        parsed.command = "help";
        break;
      case "--integration":
        parsed.integration = parseIntegration(requireValue(arg, next));
        index += 1;
        break;
      case "--lines":
      case "-n":
        parsed.logLines = parsePositiveInteger(requireValue(arg, next), arg);
        index += 1;
        break;
      case "--log-dir":
        parsed.logDir = requireValue(arg, next);
        index += 1;
        break;
      case "--name":
        parsed.serviceName = requireValue(arg, next);
        index += 1;
        break;
      case "--node":
        parsed.nodePath = requireValue(arg, next);
        index += 1;
        break;
      case "--platform":
        parsed.platform = parsePlatform(requireValue(arg, next));
        index += 1;
        break;
      case "--script":
        parsed.scriptPath = requireValue(arg, next);
        index += 1;
        break;
      case "--start":
        parsed.startAfterInstall = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function parseCommand(value: string | undefined): ServiceCliCommand {
  switch (value) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return "help";
    case "install":
    case "logs":
    case "print":
    case "restart":
    case "start":
    case "status":
    case "stop":
    case "uninstall":
      return value;
    default:
      return "help";
  }
}

function parseIntegration(value: string): ManagedIntegration {
  if (value === "all" || value === "discord" || value === "feishu" || value === "slack") {
    return value;
  }

  throw new Error(`--integration must be one of: all, discord, feishu, slack.`);
}

function parsePlatform(value: string): ServicePlatform {
  if (value === "darwin" || value === "linux") {
    return value;
  }

  throw new Error("--platform must be darwin or linux.");
}

function parseEnvAssignment(value: string): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new Error("--env expects KEY=VALUE.");
  }

  return {
    [value.slice(0, separator)]: value.slice(separator + 1)
  };
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} expects a positive integer.`);
  }

  return parsed;
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} expects a value.`);
  }

  return value;
}

function printInstalled(definition: ReturnType<typeof buildManagedServiceDefinition>): void {
  console.log(`Installed ${renderServiceId(definition)}.`);
  console.log(`Integration: ${definition.integration}`);
  console.log(`Working directory: ${definition.workingDirectory}`);
  console.log(`Entrypoint: ${definition.nodePath} ${definition.scriptPath}`);
  if (definition.configPath) {
    console.log(`Config: ${definition.configPath}`);
  }
  if (definition.launchd) {
    console.log(`LaunchAgent: ${definition.launchd.plistPath}`);
    console.log(`Logs: ${definition.launchd.stdoutPath} and ${definition.launchd.stderrPath}`);
  }
  if (definition.systemd) {
    console.log(`Unit: ${definition.systemd.unitPath}`);
  }
}

function renderServiceId(definition: ReturnType<typeof buildManagedServiceDefinition>): string {
  return definition.launchd?.label ?? definition.systemd?.unitName ?? definition.serviceName;
}

function writeCommandOutput(stdout: string, stderr: string): void {
  if (stdout) {
    process.stdout.write(`${stdout}\n`);
  }
  if (stderr) {
    process.stderr.write(`${stderr}\n`);
  }
}

async function runForeground(command: string, args: string[]): Promise<number> {
  const child = spawn(command, args, {
    stdio: "inherit"
  });

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

function printHelp(): void {
  console.log(`Usage: nuntiusctl <command> [options]

Commands:
  install      Install the user service definition
  uninstall    Stop and remove the user service
  start        Start the installed service
  stop         Stop the service
  restart      Restart the service
  status       Show service status
  logs         Show service logs
  print        Print the generated launchd plist or systemd unit

Options:
  --integration <all|discord|feishu|slack>  Entrypoint to run, default all
  --name <name>                             Service name, default nuntius
  --config <path>                           Nuntius config path
  --cwd, --working-directory <path>          Service working directory, default cwd
  --node <path>                             Node executable, default current node
  --script <path>                           Override generated entrypoint path
  --env KEY=VALUE                           Add service environment variable, repeatable
  --log-dir <path>                          launchd log directory
  --platform <darwin|linux>                 Override detected platform
  --start                                   Start immediately after install
  --lines, -n <count>                       Log lines, default 200
  --follow, -f                              Follow logs
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
