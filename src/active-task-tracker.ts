const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

export type ActiveTaskDrainResult = "drained" | "timed_out";

export class ActiveTaskTracker {
  private readonly tasks = new Set<Promise<unknown>>();

  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => {
      this.tasks.delete(task);
    });
    return task;
  }

  async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<ActiveTaskDrainResult> {
    const pending = [...this.tasks];
    if (pending.length === 0) {
      return "drained";
    }

    const timeoutResult = await new Promise<ActiveTaskDrainResult>((resolve) => {
      const timeout = setTimeout(() => {
        resolve("timed_out");
      }, timeoutMs);
      timeout.unref?.();

      void Promise.allSettled(pending).then(() => {
        clearTimeout(timeout);
        resolve("drained");
      });
    });

    return timeoutResult;
  }
}
