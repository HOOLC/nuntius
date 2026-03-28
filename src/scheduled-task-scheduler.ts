import { randomUUID } from "node:crypto";
import os from "node:os";
import process from "node:process";

import type { CodexBridgeService } from "./service.js";

const DEFAULT_SCHEDULED_TASK_POLL_INTERVAL_MS = 30_000;

export class ScheduledTaskScheduler {
  private readonly ownerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private timer?: NodeJS.Timeout;
  private started = false;
  private running = false;

  constructor(
    private readonly bridge: CodexBridgeService,
    private readonly pollIntervalMs: number = DEFAULT_SCHEDULED_TASK_POLL_INTERVAL_MS
  ) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    void this.tick();
  }

  stop(): void {
    this.started = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNextTick(): void {
    if (!this.started) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.running) {
      this.scheduleNextTick();
      return;
    }

    this.running = true;

    try {
      await this.bridge.runDueScheduledTasks({
        ownerId: this.ownerId
      });
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`Scheduled task scheduler failure: ${message}`);
    } finally {
      this.running = false;
      this.scheduleNextTick();
    }
  }
}
