import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEDULED_TASKS_SUBDIR = path.join(".nuntius", "scheduled-tasks");

export interface ScheduledTaskRequest {
  rawRequest: string;
  taskSummary: string;
  scheduleDescription: string;
  intervalMs: number;
}

export interface ScheduledTaskControlState {
  frontMatter: Record<string, string>;
  body: string;
  taskStatus: string;
  schedulerAction: "continue" | "stop";
}

interface ScheduledTaskScaffoldInput {
  taskId: string;
  repositoryId: string;
  repositoryPath: string;
  taskDir: string;
  taskDocumentPath: string;
  statusDocumentPath: string;
  rawRequest: string;
  taskSummary: string;
  scheduleDescription: string;
  createdAt: string;
  createdByUserId: string;
  sourceConversationId: string;
}

export function parseScheduledTaskRequest(text: string): ScheduledTaskRequest | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.replace(/\s+/g, " ");
  const patterns = [
    /^(?:please\s+)?create\s+(?:a\s+)?(?:scheduled\s+)?task\s+to\s+(.+?)\s+every\s+(.+?)[.!?]*$/i,
    /^(?:please\s+)?schedule\s+(.+?)\s+every\s+(.+?)[.!?]*$/i,
    /^(?:please\s+)?set\s+up\s+(?:a\s+)?(?:scheduled\s+)?task\s+to\s+(.+?)\s+every\s+(.+?)[.!?]*$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }

    const taskSummary = match[1]?.trim();
    const parsedInterval = parseInterval(match[2] ?? "");
    if (!taskSummary || !parsedInterval) {
      return undefined;
    }

    return {
      rawRequest: trimmed,
      taskSummary,
      scheduleDescription: parsedInterval.scheduleDescription,
      intervalMs: parsedInterval.intervalMs
    };
  }

  return undefined;
}

export function parseScheduledTaskSchedule(text: string): {
  scheduleDescription: string;
  intervalMs: number;
} | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }

  if (/^every\s+/i.test(normalized)) {
    return parseInterval(normalized.replace(/^every\s+/i, ""));
  }

  return parseInterval(normalized);
}

export function createScheduledTaskId(taskSummary: string, now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  const slug = sanitizePathComponent(taskSummary).slice(0, 48) || "task";
  return `${timestamp}-${slug}-${randomUUID().slice(0, 8)}`;
}

export function buildScheduledTaskPaths(repositoryPath: string, taskId: string): {
  taskDir: string;
  taskDocumentPath: string;
  statusDocumentPath: string;
} {
  const taskDir = path.join(repositoryPath, SCHEDULED_TASKS_SUBDIR, taskId);
  return {
    taskDir,
    taskDocumentPath: path.join(taskDir, "task.md"),
    statusDocumentPath: path.join(taskDir, "status.md")
  };
}

export async function writeScheduledTaskScaffold(
  input: ScheduledTaskScaffoldInput
): Promise<void> {
  await fs.mkdir(input.taskDir, { recursive: true });
  await fs.writeFile(input.taskDocumentPath, buildTaskDocumentTemplate(input), "utf8");
  await fs.writeFile(input.statusDocumentPath, buildStatusDocumentTemplate(input), "utf8");
}

export async function readScheduledTaskControlState(
  filePath: string
): Promise<ScheduledTaskControlState> {
  const parsed = parseMarkdownWithFrontMatter(await fs.readFile(filePath, "utf8"));
  return normalizeScheduledTaskControlState(parsed.frontMatter, parsed.body);
}

export async function updateScheduledTaskControlState(
  filePath: string,
  updates: Record<string, string | undefined>
): Promise<void> {
  const parsed = await readMarkdownDocument(filePath);
  const nextFrontMatter = {
    ...parsed.frontMatter
  };

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete nextFrontMatter[key];
      continue;
    }

    nextFrontMatter[key] = value;
  }

  await writeMarkdownDocument(filePath, nextFrontMatter, parsed.body);
}

export async function appendScheduledTaskStatusLog(
  filePath: string,
  heading: string,
  lines: string[]
): Promise<void> {
  const parsed = await readMarkdownDocument(filePath);
  const body = parsed.body.trimEnd();
  const sectionLines = [`### ${heading}`, ...lines.map((line) => `- ${line}`)];
  const nextBody = body.length > 0
    ? `${body}\n\n${sectionLines.join("\n")}\n`
    : `${sectionLines.join("\n")}\n`;

  await writeMarkdownDocument(filePath, parsed.frontMatter, nextBody);
}

export function scheduledTaskShouldStop(controlState: ScheduledTaskControlState): boolean {
  return controlState.schedulerAction === "stop";
}

export function buildScheduledTaskPlanningPrompt(input: {
  repositoryId: string;
  taskId: string;
  taskDir: string;
  taskDocumentPath: string;
  statusDocumentPath: string;
  rawRequest: string;
  scheduleDescription: string;
}): string {
  return [
    "You are preparing a repository-scoped scheduled task for nuntius.",
    `Repository id: ${input.repositoryId}`,
    `Task id: ${input.taskId}`,
    `Requested schedule: ${input.scheduleDescription}`,
    "",
    "The user asked for this scheduled task:",
    input.rawRequest,
    "",
    "Rewrite these files in place so they become the authoritative prompt for future executions:",
    `- ${input.taskDocumentPath}`,
    `- ${input.statusDocumentPath}`,
    "",
    "Requirements for task.md:",
    "- Make it self-contained so a future execution agent can understand the task without chat history.",
    "- Include sections for requirement/description, execution plan, expected outputs, constraints, and termination condition.",
    "- Restate the schedule clearly.",
    "- Be concrete about what the execution agent should do on each run.",
    "",
    "Requirements for status.md:",
    "- Keep YAML front matter at the top.",
    "- Preserve these keys: task_id, repository_id, schedule, task_status, scheduler_action, last_execution_id, last_execution_started_at, last_execution_finished_at, last_updated.",
    "- After planning, set task_status to active and scheduler_action to continue.",
    "- Add an initial status summary plus a log entry for the planning pass.",
    "- This file must remain self-contained and should accumulate intermediate results for each execution.",
    "",
    "Important:",
    "- The future scheduled execution agent will only receive task.md and status.md as task-specific instructions.",
    "- Do not rely on prior chat history or hidden context.",
    "- Do not ask the user follow-up questions inside the files. Make the best operational plan from the request and repository context.",
    "",
    "When you finish, reply briefly with what you prepared."
  ].join("\n");
}

export function buildScheduledTaskExecutionPrompt(input: {
  repositoryId: string;
  taskId: string;
  taskDocumentPath: string;
  statusDocumentPath: string;
  executionId: string;
}): string {
  return [
    "You are executing a repository-scoped scheduled task for nuntius.",
    `Repository id: ${input.repositoryId}`,
    `Task id: ${input.taskId}`,
    `Execution id: ${input.executionId}`,
    "",
    "Task-specific instructions are contained entirely in these files:",
    `- ${input.taskDocumentPath}`,
    `- ${input.statusDocumentPath}`,
    "",
    "Execution rules:",
    "- Read both files first.",
    "- Treat them as the only authoritative task-specific context for this run.",
    "- Carry out the next scheduled execution now.",
    "- Update status.md during this run so it records intermediate progress, findings, and the final result for this execution.",
    "- Preserve the YAML front matter in status.md.",
    "- Use scheduler_action: stop only if the termination condition in task.md has been met. Otherwise keep scheduler_action: continue.",
    "- Do not rely on chat history or prior hidden state.",
    "",
    "When you finish, reply briefly with the result and whether the task should continue."
  ].join("\n");
}

function buildTaskDocumentTemplate(input: ScheduledTaskScaffoldInput): string {
  return [
    formatFrontMatter({
      task_id: input.taskId,
      repository_id: input.repositoryId,
      schedule: input.scheduleDescription,
      created_at: input.createdAt,
      created_by_user_id: input.createdByUserId,
      source_conversation: input.sourceConversationId
    }),
    "# Scheduled Task Specification",
    "",
    "## Source Request",
    input.rawRequest,
    "",
    "## Requirement / Description",
    `Draft summary: ${input.taskSummary}`,
    "",
    "## Execution Plan",
    "Planner pending.",
    "",
    "## Expected Outputs",
    "Planner pending.",
    "",
    "## Constraints",
    `- Repository path: ${input.repositoryPath}`,
    `- Schedule: ${input.scheduleDescription}`,
    "- This document and status.md must remain sufficient for future execution without chat history.",
    "",
    "## Termination Condition",
    "Planner pending."
  ].join("\n");
}

function buildStatusDocumentTemplate(input: ScheduledTaskScaffoldInput): string {
  return [
    formatFrontMatter({
      task_id: input.taskId,
      repository_id: input.repositoryId,
      schedule: input.scheduleDescription,
      task_status: "planning",
      scheduler_action: "continue",
      last_execution_id: "none",
      last_execution_started_at: "none",
      last_execution_finished_at: "none",
      last_updated: input.createdAt
    }),
    "# Scheduled Task Status",
    "",
    "## Current Status",
    "- Lifecycle state: planning",
    "- Scheduler action: continue",
    "",
    "## Execution Log",
    `### Planning started at ${input.createdAt}`,
    `- Source request: ${input.rawRequest}`,
    `- Schedule: ${input.scheduleDescription}`,
    `- Task directory: ${input.taskDir}`
  ].join("\n");
}

async function readMarkdownDocument(filePath: string): Promise<{
  frontMatter: Record<string, string>;
  body: string;
}> {
  try {
    return parseMarkdownWithFrontMatter(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        frontMatter: {},
        body: ""
      };
    }

    throw error;
  }
}

async function writeMarkdownDocument(
  filePath: string,
  frontMatter: Record<string, string>,
  body: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${formatFrontMatter(frontMatter)}\n${body.trimStart()}`,
    "utf8"
  );
}

function parseMarkdownWithFrontMatter(raw: string): {
  frontMatter: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---\n")) {
    return {
      frontMatter: {},
      body: raw
    };
  }

  const endMarker = raw.indexOf("\n---\n", 4);
  if (endMarker < 0) {
    return {
      frontMatter: {},
      body: raw
    };
  }

  const frontMatterBlock = raw.slice(4, endMarker);
  const body = raw.slice(endMarker + "\n---\n".length);
  return {
    frontMatter: parseFrontMatter(frontMatterBlock),
    body
  };
}

function parseFrontMatter(block: string): Record<string, string> {
  const frontMatter: Record<string, string> = {};

  for (const line of block.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) {
      continue;
    }

    frontMatter[key] = value;
  }

  return frontMatter;
}

function formatFrontMatter(values: Record<string, string | undefined>): string {
  const lines = ["---"];

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }

    lines.push(`${key}: ${value}`);
  }

  lines.push("---");
  return lines.join("\n");
}

function normalizeScheduledTaskControlState(
  frontMatter: Record<string, string>,
  body: string
): ScheduledTaskControlState {
  const taskStatus = normalizeSimpleValue(frontMatter.task_status) || "active";
  const schedulerAction = normalizeSimpleValue(frontMatter.scheduler_action) === "stop"
    ? "stop"
    : "continue";

  return {
    frontMatter,
    body,
    taskStatus,
    schedulerAction
  };
}

function normalizeSimpleValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function parseInterval(rawInterval: string): {
  scheduleDescription: string;
  intervalMs: number;
} | undefined {
  const normalized = rawInterval.trim().replace(/[.!?]+$/g, "").toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const shortMatch = normalized.match(/^(\d+)\s*([smhdw])$/i);
  if (shortMatch) {
    const amount = Number.parseInt(shortMatch[1] ?? "", 10);
    return buildParsedInterval(amount, shortMatch[2] ?? "");
  }

  const amountUnitMatch = normalized.match(/^(an?|one|\d+)?\s*([a-z]+)$/i);
  if (!amountUnitMatch) {
    return undefined;
  }

  const amountToken = amountUnitMatch[1]?.trim();
  const unitToken = amountUnitMatch[2]?.trim() ?? "";
  const amount = amountToken && /^\d+$/.test(amountToken)
    ? Number.parseInt(amountToken, 10)
    : amountToken
      ? 1
      : 1;

  return buildParsedInterval(amount, unitToken);
}

function buildParsedInterval(
  amount: number,
  rawUnit: string
): {
  scheduleDescription: string;
  intervalMs: number;
} | undefined {
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const canonicalUnit = normalizeUnit(rawUnit);
  if (!canonicalUnit) {
    return undefined;
  }

  const intervalMs = amount * canonicalUnit.ms;
  return {
    intervalMs,
    scheduleDescription: `every ${amount} ${amount === 1 ? canonicalUnit.singular : canonicalUnit.plural}`
  };
}

function normalizeUnit(rawUnit: string): {
  singular: string;
  plural: string;
  ms: number;
} | undefined {
  const unit = rawUnit.trim().toLowerCase();

  switch (unit) {
    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return {
        singular: "second",
        plural: "seconds",
        ms: 1_000
      };
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return {
        singular: "minute",
        plural: "minutes",
        ms: 60_000
      };
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return {
        singular: "hour",
        plural: "hours",
        ms: 60 * 60_000
      };
    case "d":
    case "day":
    case "days":
      return {
        singular: "day",
        plural: "days",
        ms: 24 * 60 * 60_000
      };
    case "w":
    case "week":
    case "weeks":
      return {
        singular: "week",
        plural: "weeks",
        ms: 7 * 24 * 60 * 60_000
      };
    default:
      return undefined;
  }
}

function sanitizePathComponent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
