import process from "node:process";

export type WorkerMode = "run" | "probe";

export type WorkerToSupervisorMessage =
  | {
      type: "ready";
      tag?: string;
    }
  | {
      type: "probe_ready";
    }
  | {
      type: "request_hot_reload";
    }
  | {
      type: "request_restart";
    };

export type SupervisorToWorkerMessage = {
  type: "shutdown";
};

export function isWorkerToSupervisorMessage(
  value: unknown
): value is WorkerToSupervisorMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "ready" ||
      value.type === "probe_ready" ||
      value.type === "request_hot_reload" ||
      value.type === "request_restart")
  );
}

export function isSupervisorToWorkerMessage(
  value: unknown
): value is SupervisorToWorkerMessage {
  return typeof value === "object" && value !== null && "type" in value && value.type === "shutdown";
}

export function resolveWorkerMode(raw: string | undefined): WorkerMode | undefined {
  if (raw === "run" || raw === "probe") {
    return raw;
  }

  return undefined;
}

export function sendWorkerMessage(message: WorkerToSupervisorMessage): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

export async function sendWorkerMessageAndExit(
  message: WorkerToSupervisorMessage
): Promise<void> {
  if (typeof process.send === "function") {
    await new Promise<void>((resolve, reject) => {
      process.send?.(message, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  process.exit(0);
}
