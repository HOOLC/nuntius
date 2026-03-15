export type DiscordWorkerMode = "run" | "probe";

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
