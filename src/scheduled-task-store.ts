import { promises as fs } from "node:fs";
import path from "node:path";

import type { ApprovalPolicy, SandboxMode } from "./domain.js";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_MAX_ATTEMPTS = 200;

export type ScheduledTaskState = "active" | "running" | "completed";
export type ScheduledTaskRunOutcome = "success" | "failed" | "stopped";

export interface ScheduledTaskExecutionLease {
  ownerId: string;
  executionId: string;
  startedAt: string;
  leaseExpiresAt: string;
}

export interface ScheduledTaskRecord {
  id: string;
  repositoryId: string;
  repositoryPath: string;
  sandboxMode: SandboxMode;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  codexConfigOverrides?: string[];
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
  taskDir: string;
  taskDocumentPath: string;
  statusDocumentPath: string;
  rawRequest: string;
  taskSummary: string;
  scheduleDescription: string;
  intervalMs: number;
  state: ScheduledTaskState;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunStartedAt?: string;
  lastRunCompletedAt?: string;
  lastRunOutcome?: ScheduledTaskRunOutcome;
  lastError?: string;
  runCount: number;
  activeExecution?: ScheduledTaskExecutionLease;
}

interface ScheduledTaskStoreFile {
  tasks: ScheduledTaskRecord[];
}

export function deriveScheduledTaskStorePath(sessionStorePath: string): string {
  return path.join(path.dirname(sessionStorePath), "scheduled-tasks.json");
}

export class FileScheduledTaskStore {
  private readonly lockPath: string;

  constructor(private readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
  }

  async list(): Promise<ScheduledTaskRecord[]> {
    const store = await this.readStoreFile();
    return sortTasks(store.tasks);
  }

  async get(taskId: string): Promise<ScheduledTaskRecord | undefined> {
    const store = await this.readStoreFile();
    return store.tasks.find((task) => task.id === taskId);
  }

  async create(task: ScheduledTaskRecord): Promise<void> {
    await this.withLock(async () => {
      const store = await this.readStoreFile();
      if (store.tasks.some((existingTask) => existingTask.id === task.id)) {
        throw new Error(`Scheduled task "${task.id}" already exists.`);
      }

      store.tasks.push(task);
      await this.writeStoreFile(store);
    });
  }

  async claimDueTask(input: {
    ownerId: string;
    executionId: string;
    now: string;
    leaseMs: number;
  }): Promise<ScheduledTaskRecord | undefined> {
    return this.withLock(async () => {
      const store = await this.readStoreFile();
      const dueTask = findDueTask(store.tasks, input.now);
      if (!dueTask) {
        return undefined;
      }

      const claimedTask: ScheduledTaskRecord = {
        ...dueTask,
        state: "running",
        updatedAt: input.now,
        lastRunStartedAt: input.now,
        activeExecution: {
          ownerId: input.ownerId,
          executionId: input.executionId,
          startedAt: input.now,
          leaseExpiresAt: new Date(Date.parse(input.now) + input.leaseMs).toISOString()
        }
      };

      replaceTask(store.tasks, claimedTask);
      await this.writeStoreFile(store);
      return claimedTask;
    });
  }

  async renewLease(input: {
    taskId: string;
    ownerId: string;
    executionId: string;
    now: string;
    leaseMs: number;
  }): Promise<boolean> {
    return this.withLock(async () => {
      const store = await this.readStoreFile();
      const task = store.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task?.activeExecution) {
        return false;
      }

      if (
        task.activeExecution.ownerId !== input.ownerId ||
        task.activeExecution.executionId !== input.executionId
      ) {
        return false;
      }

      const renewedTask: ScheduledTaskRecord = {
        ...task,
        updatedAt: input.now,
        activeExecution: {
          ...task.activeExecution,
          leaseExpiresAt: new Date(Date.parse(input.now) + input.leaseMs).toISOString()
        }
      };

      replaceTask(store.tasks, renewedTask);
      await this.writeStoreFile(store);
      return true;
    });
  }

  async completeExecution(input: {
    taskId: string;
    ownerId: string;
    executionId: string;
    finishedAt: string;
    stop: boolean;
  }): Promise<ScheduledTaskRecord | undefined> {
    return this.withLock(async () => {
      const store = await this.readStoreFile();
      const task = store.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task?.activeExecution) {
        return undefined;
      }

      if (
        task.activeExecution.ownerId !== input.ownerId ||
        task.activeExecution.executionId !== input.executionId
      ) {
        return undefined;
      }

      const completedTask: ScheduledTaskRecord = {
        ...task,
        state: input.stop ? "completed" : "active",
        updatedAt: input.finishedAt,
        nextRunAt: input.stop
          ? undefined
          : new Date(Date.parse(input.finishedAt) + task.intervalMs).toISOString(),
        lastRunCompletedAt: input.finishedAt,
        lastRunOutcome: input.stop ? "stopped" : "success",
        lastError: undefined,
        runCount: task.runCount + 1,
        activeExecution: undefined
      };

      replaceTask(store.tasks, completedTask);
      await this.writeStoreFile(store);
      return completedTask;
    });
  }

  async failExecution(input: {
    taskId: string;
    ownerId: string;
    executionId: string;
    finishedAt: string;
    errorMessage: string;
  }): Promise<ScheduledTaskRecord | undefined> {
    return this.withLock(async () => {
      const store = await this.readStoreFile();
      const task = store.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task?.activeExecution) {
        return undefined;
      }

      if (
        task.activeExecution.ownerId !== input.ownerId ||
        task.activeExecution.executionId !== input.executionId
      ) {
        return undefined;
      }

      const failedTask: ScheduledTaskRecord = {
        ...task,
        state: "active",
        updatedAt: input.finishedAt,
        nextRunAt: new Date(Date.parse(input.finishedAt) + task.intervalMs).toISOString(),
        lastRunCompletedAt: input.finishedAt,
        lastRunOutcome: "failed",
        lastError: input.errorMessage,
        runCount: task.runCount + 1,
        activeExecution: undefined
      };

      replaceTask(store.tasks, failedTask);
      await this.writeStoreFile(store);
      return failedTask;
    });
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireLock();

    try {
      return await task();
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        await handle.close();
        return;
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }

        await this.clearStaleLockIfNeeded();
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    throw new Error(`Timed out waiting for scheduled task store lock: ${this.lockPath}`);
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(this.lockPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  private async clearStaleLockIfNeeded(): Promise<void> {
    try {
      const stats = await fs.stat(this.lockPath);
      if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) {
        return;
      }

      await fs.unlink(this.lockPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  private async readStoreFile(): Promise<ScheduledTaskStoreFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ScheduledTaskStoreFile>;
      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          tasks: []
        };
      }

      throw error;
    }
  }

  private async writeStoreFile(store: ScheduledTaskStoreFile): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    const payload: ScheduledTaskStoreFile = {
      tasks: sortTasks(store.tasks)
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

function findDueTask(
  tasks: ScheduledTaskRecord[],
  now: string
): ScheduledTaskRecord | undefined {
  const nowValue = Date.parse(now);

  return sortTasks(tasks).find((task) => {
    if (task.state === "completed") {
      return false;
    }

    if (!task.nextRunAt || Number.isNaN(Date.parse(task.nextRunAt))) {
      return false;
    }

    if (Date.parse(task.nextRunAt) > nowValue) {
      return false;
    }

    if (!task.activeExecution) {
      return true;
    }

    return Date.parse(task.activeExecution.leaseExpiresAt) <= nowValue;
  });
}

function replaceTask(tasks: ScheduledTaskRecord[], nextTask: ScheduledTaskRecord): void {
  const index = tasks.findIndex((task) => task.id === nextTask.id);
  if (index < 0) {
    throw new Error(`Unknown scheduled task "${nextTask.id}".`);
  }

  tasks[index] = nextTask;
}

function sortTasks(tasks: ScheduledTaskRecord[]): ScheduledTaskRecord[] {
  return [...tasks].sort((left, right) => {
    const leftNextRun = left.nextRunAt ? Date.parse(left.nextRunAt) : Number.POSITIVE_INFINITY;
    const rightNextRun = right.nextRunAt ? Date.parse(right.nextRunAt) : Number.POSITIVE_INFINITY;

    if (leftNextRun !== rightNextRun) {
      return leftNextRun - rightNextRun;
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
