import process from "node:process";

import { createBridgeRuntime } from "./bridge-runtime.js";

async function main(): Promise<void> {
  const { config } = createBridgeRuntime();

  console.log("Nuntius scaffold is ready.");
  console.log(`Config source: ${config.configFilePath ?? "env"}`);
  console.log(`Default repository target: ${config.defaultRepositoryId}`);
  console.log(
    `Repository registry source: ${config.repositoryRegistryPath ?? config.configFilePath ?? "env"}`
  );
  console.log(
    `Explicit repository selection required: ${String(config.requireExplicitRepositorySelection)}`
  );
  console.log(`Handler workspace: ${config.handlerWorkspacePath}`);
  console.log(`Handler sandbox: ${config.handlerSandboxMode}`);
  console.log(`Session store: ${config.sessionStorePath}`);
  console.log("Use `npm run discord:start` to run the Discord integration.");
  console.log("Use `npm run slack:start` to run the Slack integration.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
