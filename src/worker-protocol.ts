import type { CodexDynamicToolCall, CodexDynamicToolSpec } from "./codex-runner.js";
import type { ConversationLanguage } from "./domain.js";

const MAX_WAKE_DURATION_MS = 30 * 24 * 60 * 60_000;

export const WORKER_BRIDGE_TOOL_NAMESPACE = "nuntius";
export const WAKE_AFTER_TOOL_USAGE = "`nuntius.wake_after` with `{ \"duration\": \"5m\" }`";

export type WorkerControlAction = {
  action: "wake_after";
  durationMs: number;
};

export interface WorkerDecision {
  message?: string;
  actions: WorkerControlAction[];
}

export function buildWorkerDynamicTools(): CodexDynamicToolSpec[] {
  return [
    {
      namespace: WORKER_BRIDGE_TOOL_NAMESPACE,
      name: "wake_after",
      description: [
        "Ask nuntius to wake this same worker session up later in the background.",
        "Use only when the task genuinely requires time to pass before continuing, such as waiting, polling, or monitoring."
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          duration: {
            type: "string",
            description: "Delay such as 30s, 5m, 2h, or 1d. Maximum is 30 days."
          }
        },
        required: ["duration"],
        additionalProperties: false
      }
    }
  ];
}

export function parseWorkerToolCall(
  call: Pick<CodexDynamicToolCall, "namespace" | "tool" | "arguments">
): WorkerControlAction {
  if (call.namespace !== WORKER_BRIDGE_TOOL_NAMESPACE) {
    throw new Error(
      `Unsupported worker bridge tool namespace: ${call.namespace ?? "none"}.`
    );
  }

  if (call.tool !== "wake_after") {
    throw new Error(`Unsupported worker bridge tool: ${call.tool}.`);
  }

  const args = readToolArguments(call.arguments);
  const duration = readRequiredString(args, "duration");
  return {
    action: "wake_after",
    durationMs: parseWakeDuration(duration)
  };
}

export function parseWorkerDecision(rawText: string): WorkerDecision {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      message: undefined,
      actions: []
    };
  }

  return {
    message: trimmed,
    actions: []
  };
}

export function formatWakeDuration(
  durationMs: number,
  language: ConversationLanguage
): string {
  const units = [
    {
      ms: 24 * 60 * 60_000,
      enSingular: "day",
      enPlural: "days",
      zh: "天"
    },
    {
      ms: 60 * 60_000,
      enSingular: "hour",
      enPlural: "hours",
      zh: "小时"
    },
    {
      ms: 60_000,
      enSingular: "minute",
      enPlural: "minutes",
      zh: "分钟"
    },
    {
      ms: 1_000,
      enSingular: "second",
      enPlural: "seconds",
      zh: "秒"
    }
  ];

  for (const unit of units) {
    if (durationMs >= unit.ms && durationMs % unit.ms === 0) {
      const value = durationMs / unit.ms;
      return language === "zh"
        ? `${value}${unit.zh}`
        : `${value} ${value === 1 ? unit.enSingular : unit.enPlural}`;
    }
  }

  return language === "zh" ? `${durationMs}毫秒` : `${durationMs} ms`;
}

export function parseWakeDuration(payload: string): number {
  const normalized = payload.trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) {
    throw new Error("wake_after requires a delay like 30s, 5m, 2h, or 1d.");
  }

  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("wake_after requires a positive integer delay.");
  }

  const unit = match[2];
  const multiplier =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 60 * 60_000
          : 24 * 60 * 60_000;
  const durationMs = value * multiplier;
  if (durationMs > MAX_WAKE_DURATION_MS) {
    throw new Error("wake_after exceeds the maximum supported delay of 30 days.");
  }

  return durationMs;
}

function readToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Worker bridge tool arguments must be an object.");
  }

  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }

  return value;
}
