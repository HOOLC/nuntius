import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  isProcessGuardActive,
  PROCESS_RESTART_EXIT_CODE,
  runModuleWithRestartGuard
} from "./process-guard.js";
import { maybeRelaunchCurrentProcessPersistently } from "./persistent-launch.js";
import { ChildWorkerSupervisor } from "./worker-supervisor.js";

const DISCORD_MODULE_PATH = fileURLToPath(import.meta.url);

async function runDiscordProcess(): Promise<void> {
  const supervisor = new ChildWorkerSupervisor({
    serviceLabel: "Discord",
    workerModulePath: fileURLToPath(new URL("./discord-bot-worker.js", import.meta.url)),
    workerModeEnvKey: "NUNTIUS_DISCORD_WORKER_MODE",
    restartExitCode: PROCESS_RESTART_EXIT_CODE
  });
  await supervisor.start();
}

async function main(): Promise<void> {
  if (await maybeRelaunchCurrentProcessPersistently({ label: "Discord bot" })) {
    return;
  }

  if (!isProcessGuardActive()) {
    await runModuleWithRestartGuard({
      label: "Discord bot",
      modulePath: DISCORD_MODULE_PATH
    });
    return;
  }

  await runDiscordProcess();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
