import process from "node:process";

import { runModuleWithRestartGuard } from "../../dist/process-guard.js";

const childModulePath = process.env.NUNTIUS_TEST_CHILD_MODULE_PATH;

if (!childModulePath) {
  throw new Error("NUNTIUS_TEST_CHILD_MODULE_PATH is required.");
}

runModuleWithRestartGuard({
  label: "fixture child",
  modulePath: childModulePath,
  env: process.env,
  respawnDelayMs: 10
}).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
