import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadNuntiusConfigFile, readTable } from "./config-file.js";

type IntegrationName = "discord" | "feishu" | "slack";

interface IntegrationSpec {
  name: IntegrationName;
  configTable: string;
  envKeys: string[];
  modulePath: string;
}

export interface IntegrationSelection {
  enabled: IntegrationName[];
  skipped: IntegrationName[];
}

const INTEGRATIONS: IntegrationSpec[] = [
  {
    name: "discord",
    configTable: "discord",
    envKeys: ["NUNTIUS_DISCORD_TOKEN", "NUNTIUS_DISCORD_APPLICATION_ID"],
    modulePath: fileURLToPath(new URL("./discord-bot.js", import.meta.url))
  },
  {
    name: "feishu",
    configTable: "feishu",
    envKeys: ["NUNTIUS_FEISHU_APP_ID", "NUNTIUS_FEISHU_APP_SECRET"],
    modulePath: fileURLToPath(new URL("./feishu-bot.js", import.meta.url))
  },
  {
    name: "slack",
    configTable: "slack",
    envKeys: ["NUNTIUS_SLACK_BOT_TOKEN", "NUNTIUS_SLACK_SIGNING_SECRET"],
    modulePath: fileURLToPath(new URL("./slack-bot.js", import.meta.url))
  }
];

export function detectConfiguredIntegrations(
  env: NodeJS.ProcessEnv = process.env
): IntegrationSelection {
  const configFile = loadNuntiusConfigFile();
  const document = configFile?.document;

  const enabled = INTEGRATIONS
    .filter((integration) => hasIntegrationConfig(integration, document, env))
    .map((integration) => integration.name);

  return {
    enabled,
    skipped: INTEGRATIONS
      .map((integration) => integration.name)
      .filter((integrationName) => !enabled.includes(integrationName))
  };
}

export async function runConfiguredIntegrations(
  env: NodeJS.ProcessEnv = process.env
): Promise<IntegrationSelection> {
  const selection = detectConfiguredIntegrations(env);

  if (selection.enabled.length === 0) {
    console.log("No IM integrations are configured. Skipping Discord, Feishu, and Slack.");
    return selection;
  }

  console.log(`Starting IM integrations: ${selection.enabled.join(", ")}.`);
  if (selection.skipped.length > 0) {
    console.log(`Skipping unconfigured integrations: ${selection.skipped.join(", ")}.`);
  }

  const children = selection.enabled.map((integrationName) => {
    const integration = resolveIntegration(integrationName);
    const child = spawn(process.execPath, [integration.modulePath], {
      env,
      stdio: "inherit"
    });

    return {
      integrationName,
      child
    };
  });

  await waitForChildren(children);
  return selection;
}

export async function main(): Promise<void> {
  await runConfiguredIntegrations();
}

function hasIntegrationConfig(
  integration: IntegrationSpec,
  document: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv
): boolean {
  return Boolean(
    (document && readTable(document, integration.configTable)) ||
      integration.envKeys.some((key) => Boolean(env[key]))
  );
}

function resolveIntegration(name: IntegrationName): IntegrationSpec {
  const integration = INTEGRATIONS.find((candidate) => candidate.name === name);
  if (!integration) {
    throw new Error(`Unknown integration: ${name}`);
  }

  return integration;
}

async function waitForChildren(
  children: Array<{
    integrationName: IntegrationName;
    child: ChildProcess;
  }>
): Promise<void> {
  let shuttingDown = false;
  let settled = false;
  let activeChildren = children.length;

  await new Promise<void>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn();
    };

    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      for (const { child } of children) {
        if (child.exitCode === null && !child.killed) {
          child.kill(signal);
        }
      }
    };

    const handleSignal = (signal: NodeJS.Signals) => {
      shutdown(signal);
    };

    const cleanup = (): void => {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    };

    const handleSigint = (): void => {
      handleSignal("SIGINT");
    };

    const handleSigterm = (): void => {
      handleSignal("SIGTERM");
    };

    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);

    for (const { integrationName, child } of children) {
      child.once("error", (error) => {
        shuttingDown = true;
        for (const { child: sibling } of children) {
          if (sibling !== child && sibling.exitCode === null && !sibling.killed) {
            sibling.kill("SIGTERM");
          }
        }

        finish(() => {
          reject(new Error(`Failed to start ${integrationName}: ${error.message}`));
        });
      });

      child.once("exit", (code, signal) => {
        activeChildren -= 1;

        if (shuttingDown) {
          if (activeChildren === 0) {
            finish(resolve);
          }
          return;
        }

        shuttingDown = true;
        for (const { child: sibling } of children) {
          if (sibling !== child && sibling.exitCode === null && !sibling.killed) {
            sibling.kill("SIGTERM");
          }
        }

        finish(() => {
          reject(
            new Error(
              `${integrationName} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`
            )
          );
        });
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
