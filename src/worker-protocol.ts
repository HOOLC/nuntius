import type { ConversationLanguage } from "./domain.js";

const MAX_WAKE_DURATION_MS = 30 * 24 * 60 * 60_000;

export const WAKE_AFTER_ACTION_USAGE = "[[ACTION:WAKE_AFTER(5m)]]";

export type WorkerControlAction = {
  action: "wake_after";
  durationMs: number;
};

export interface WorkerDecision {
  message?: string;
  actions: WorkerControlAction[];
}

interface TaggedWorkerAction {
  start: number;
  end: number;
  action: WorkerControlAction;
}

export function parseWorkerDecision(rawText: string): WorkerDecision {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      message: undefined,
      actions: []
    };
  }

  if (!trimmed.includes("[[ACTION:")) {
    return {
      message: trimmed,
      actions: []
    };
  }

  const taggedActions = scanTaggedActions(rawText);
  const message = stripTaggedActions(rawText, taggedActions);
  return {
    message: message || undefined,
    actions: taggedActions.map((taggedAction) => taggedAction.action)
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

function scanTaggedActions(rawText: string): TaggedWorkerAction[] {
  const actions: TaggedWorkerAction[] = [];
  let cursor = 0;

  while (cursor < rawText.length) {
    const start = rawText.indexOf("[[ACTION:", cursor);
    if (start < 0) {
      break;
    }

    const actionNameStart = start + "[[ACTION:".length;
    const openParen = rawText.indexOf("(", actionNameStart);
    if (openParen < 0) {
      throw new Error("Malformed worker action tag.");
    }

    const actionName = rawText.slice(actionNameStart, openParen).trim().toUpperCase();
    let depth = 1;
    let index = openParen + 1;

    while (index < rawText.length && depth > 0) {
      const character = rawText[index];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
      index += 1;
    }

    if (depth !== 0 || rawText.slice(index, index + 2) !== "]]") {
      throw new Error("Malformed worker action tag.");
    }

    const payload = rawText.slice(openParen + 1, index - 1).trim();
    actions.push({
      start,
      end: index + 2,
      action: parseTaggedAction(actionName, payload)
    });
    cursor = index + 2;
  }

  return actions;
}

function stripTaggedActions(rawText: string, actions: TaggedWorkerAction[]): string {
  if (actions.length === 0) {
    return rawText.trim();
  }

  let cursor = 0;
  const segments: string[] = [];
  for (const action of actions) {
    segments.push(rawText.slice(cursor, action.start));
    cursor = action.end;
  }
  segments.push(rawText.slice(cursor));

  return segments.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function parseTaggedAction(actionName: string, payload: string): WorkerControlAction {
  switch (actionName) {
    case "WAKE_AFTER":
      return {
        action: "wake_after",
        durationMs: parseWakeDuration(payload)
      };
    default:
      throw new Error(`Unsupported worker action tag: ${actionName}.`);
  }
}

function parseWakeDuration(payload: string): number {
  const normalized = payload.trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) {
    throw new Error("WAKE_AFTER requires a delay like 30s, 5m, 2h, or 1d.");
  }

  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("WAKE_AFTER requires a positive integer delay.");
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
    throw new Error("WAKE_AFTER exceeds the maximum supported delay of 30 days.");
  }

  return durationMs;
}
