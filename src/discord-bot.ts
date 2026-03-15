import { fork, type ChildProcess } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  isWorkerToSupervisorMessage,
  type DiscordWorkerMode,
  type SupervisorToWorkerMessage,
  type WorkerToSupervisorMessage
} from "./discord-supervisor-protocol.js";

const WORKER_BOOT_TIMEOUT_MS = 30_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
const WORKER_RESPAWN_DELAY_MS = 1_000;

class DiscordBotSupervisor {
  private readonly workerModulePath = fileURLToPath(new URL("./discord-bot-worker.js", import.meta.url));
  private worker?: ChildProcess;
  private shuttingDown = false;
  private reloading = false;

  async start(): Promise<void> {
    this.installSignalHandlers();
    this.worker = await this.startRunWorker("initial startup");
  }

  private installSignalHandlers(): void {
    process.on("SIGHUP", () => {
      void this.hotReload("SIGHUP");
    });

    process.on("SIGINT", () => {
      void this.shutdownAndExit(0);
    });

    process.on("SIGTERM", () => {
      void this.shutdownAndExit(0);
    });
  }

  private async hotReload(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (this.reloading) {
      console.log(`Ignoring hot reload request while a reload is already in progress: ${reason}.`);
      return;
    }

    this.reloading = true;

    try {
      console.log(`Hot reload requested: ${reason}. Probing the latest Discord worker build.`);
      await this.runProbe();
      console.log("Probe succeeded. Replacing the active Discord worker.");

      const previousWorker = this.worker;
      if (previousWorker) {
        await this.stopWorker(previousWorker, "hot reload");
      }

      this.worker = await this.startRunWorker("hot reload");
      console.log("Hot reload completed.");
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`Hot reload failed:\n${message}`);
    } finally {
      this.reloading = false;
    }
  }

  private async shutdownAndExit(exitCode: number): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    try {
      if (this.worker) {
        const activeWorker = this.worker;
        this.worker = undefined;
        await this.stopWorker(activeWorker, "supervisor shutdown");
      }
    } finally {
      process.exit(exitCode);
    }
  }

  private async startRunWorker(reason: string): Promise<ChildProcess> {
    const child = this.spawnWorker("run");
    this.attachRuntimeHandlers(child);
    await this.waitForWorkerReady(child, "ready");
    console.log(`Discord worker ${child.pid ?? "unknown"} started for ${reason}.`);
    return child;
  }

  private async runProbe(): Promise<void> {
    const probe = this.spawnWorker("probe");
    let probeReady = false;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while probing the Discord worker."));
      }, WORKER_BOOT_TIMEOUT_MS);

      probe.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      probe.on("message", (message) => {
        if (isWorkerToSupervisorMessage(message) && message.type === "probe_ready") {
          probeReady = true;
        }
      });

      probe.once("exit", (code, signal) => {
        clearTimeout(timeout);

        if (probeReady && code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(
            `Probe worker exited before confirming readiness (code=${code ?? "null"}, signal=${signal ?? "null"}).`
          )
        );
      });
    });
  }

  private attachRuntimeHandlers(child: ChildProcess): void {
    child.on("message", (message) => {
      if (!isWorkerToSupervisorMessage(message)) {
        return;
      }

      this.handleWorkerMessage(child, message);
    });

    child.once("exit", (code, signal) => {
      this.handleWorkerExit(child, code, signal);
    });
  }

  private handleWorkerMessage(child: ChildProcess, message: WorkerToSupervisorMessage): void {
    switch (message.type) {
      case "ready":
      case "probe_ready":
        return;
      case "request_hot_reload":
        void this.hotReload(`admin request from worker ${child.pid ?? "unknown"}`);
        return;
      case "request_restart":
        console.log("Supervisor exit requested by Discord admin command.");
        void this.shutdownAndExit(75);
        return;
    }
  }

  private handleWorkerExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (child !== this.worker) {
      return;
    }

    this.worker = undefined;

    if (this.shuttingDown) {
      return;
    }

    if (this.reloading) {
      console.log(
        `Discord worker ${child.pid ?? "unknown"} exited during reload (code=${code ?? "null"}, signal=${signal ?? "null"}).`
      );
      return;
    }

    console.error(
      `Discord worker ${child.pid ?? "unknown"} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`
    );

    setTimeout(() => {
      if (this.shuttingDown || this.reloading || this.worker) {
        return;
      }

      void this.startRunWorker("crash recovery")
        .then((worker) => {
          this.worker = worker;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          console.error(`Failed to restart Discord worker after crash:\n${message}`);
        });
    }, WORKER_RESPAWN_DELAY_MS);
  }

  private spawnWorker(mode: DiscordWorkerMode): ChildProcess {
    return fork(this.workerModulePath, [], {
      env: {
        ...process.env,
        NUNTIUS_DISCORD_WORKER_MODE: mode
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    });
  }

  private async waitForWorkerReady(
    child: ChildProcess,
    expectedMessageType: Extract<WorkerToSupervisorMessage["type"], "ready">
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while waiting for the Discord worker to become ready."));
      }, WORKER_BOOT_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off("message", handleMessage);
        child.off("error", handleError);
        child.off("exit", handleExit);
      };

      const handleMessage = (message: unknown): void => {
        if (!isWorkerToSupervisorMessage(message)) {
          return;
        }

        if (message.type === expectedMessageType) {
          cleanup();
          resolve();
        }
      };

      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(
          new Error(
            `Discord worker exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"}).`
          )
        );
      };

      child.on("message", handleMessage);
      child.once("error", handleError);
      child.once("exit", handleExit);
    });
  }

  private async stopWorker(child: ChildProcess, reason: string): Promise<void> {
    if (child.exitCode !== null || child.killed) {
      return;
    }

    console.log(`Stopping Discord worker ${child.pid ?? "unknown"}: ${reason}.`);

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout);
        child.off("exit", handleExit);
        child.off("error", handleError);
        resolve();
      };

      const handleExit = (): void => {
        finish();
      };

      const handleError = (): void => {
        finish();
      };

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, WORKER_SHUTDOWN_TIMEOUT_MS);

      child.once("exit", handleExit);
      child.once("error", handleError);

      if (child.connected) {
        child.send({
          type: "shutdown"
        } satisfies SupervisorToWorkerMessage);
        return;
      }

      child.kill("SIGTERM");
    });
  }
}

async function main(): Promise<void> {
  const supervisor = new DiscordBotSupervisor();
  await supervisor.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
