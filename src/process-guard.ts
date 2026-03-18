import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

export const PROCESS_RESTART_EXIT_CODE = 75;
export const PROCESS_GUARD_CHILD_ENV_KEY = "NUNTIUS_PROCESS_GUARD_CHILD";

const PROCESS_GUARD_RESPAWN_DELAY_MS = 250;

interface ProcessGuardOptions {
  label: string;
  modulePath: string;
  env?: NodeJS.ProcessEnv;
  respawnDelayMs?: number;
}

export function isProcessGuardActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROCESS_GUARD_CHILD_ENV_KEY] === "1";
}

export async function runModuleWithRestartGuard(options: ProcessGuardOptions): Promise<void> {
  const env = options.env ?? process.env;
  const respawnDelayMs = options.respawnDelayMs ?? PROCESS_GUARD_RESPAWN_DELAY_MS;
  let activeChild: ChildProcess | undefined;
  let shuttingDown = false;
  let respawnTimer: NodeJS.Timeout | undefined;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn();
    };

    const cleanup = (): void => {
      if (respawnTimer) {
        clearTimeout(respawnTimer);
        respawnTimer = undefined;
      }

      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    };

    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;

      if (respawnTimer) {
        finish(resolve);
        return;
      }

      if (activeChild && activeChild.exitCode === null && !activeChild.killed) {
        activeChild.kill(signal);
        return;
      }

      finish(resolve);
    };

    const handleSigint = (): void => {
      shutdown("SIGINT");
    };

    const handleSigterm = (): void => {
      shutdown("SIGTERM");
    };

    const startChild = (): void => {
      try {
        activeChild = spawn(process.execPath, [options.modulePath], {
          env: {
            ...env,
            [PROCESS_GUARD_CHILD_ENV_KEY]: "1"
          },
          stdio: "inherit"
        });
      } catch (error) {
        finish(() => {
          reject(
            new Error(
              `Failed to start ${options.label}: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        });
        return;
      }

      activeChild.once("error", (error) => {
        activeChild = undefined;
        finish(() => {
          reject(new Error(`Failed to start ${options.label}: ${error.message}`));
        });
      });

      activeChild.once("exit", (code, signal) => {
        activeChild = undefined;

        if (shuttingDown) {
          finish(resolve);
          return;
        }

        if (code === PROCESS_RESTART_EXIT_CODE) {
          console.log(`${options.label} requested restart. Starting a fresh process.`);
          respawnTimer = setTimeout(() => {
            respawnTimer = undefined;

            if (shuttingDown) {
              finish(resolve);
              return;
            }

            startChild();
          }, respawnDelayMs);
          return;
        }

        if (code === 0) {
          finish(resolve);
          return;
        }

        finish(() => {
          reject(
            new Error(
              `${options.label} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`
            )
          );
        });
      });
    };

    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);

    startChild();
  });
}
