import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { InteractionRouter, parseBridgeCommand } from "../dist/interaction-router.js";
import { CodexBridgeService } from "../dist/service.js";
import { FileSessionStore } from "../dist/session-store.js";
import { SerialTurnQueue } from "../dist/serial-turn-queue.js";

test("top-level handler sessions can create scheduled tasks without binding the thread", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-scheduled-task-create-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const calls = [];
  const service = new CodexBridgeService(
    buildConfig(root, handlerDir, [
      {
        id: "repo",
        path: repoDir,
        sandboxMode: "workspace-write"
      }
    ]),
    new FileSessionStore(path.join(root, "sessions.json")),
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);

        if (request.repositoryPath === handlerDir) {
          assert.match(request.prompt, /Available repositories and settings:/);
          assert.match(request.prompt, /repo \(sandbox=workspace-write, model=default, codex_network_access=disabled\)/);
          return {
            sessionId: "handler-session-1",
            responseText: [
              '[[ACTION:SCHEDULE({"repositoryId":"repo","schedule":"every 1 hour","taskPrompt":"check status"})]]',
              "Creating the scheduled task."
            ].join("\n"),
            rawEvents: [],
            stderrLines: []
          };
        }

        const taskDir = getOnlyTaskDir(repoDir);
        writeFileSync(
          path.join(taskDir, "task.md"),
          [
            "---",
            "task_id: planned-task",
            "repository_id: repo",
            "schedule: every 1 hour",
            "---",
            "# Scheduled Task Specification",
            "",
            "## Requirement / Description",
            "Check the repository status once per hour.",
            "",
            "## Execution Plan",
            "Inspect the repository and report status.",
            "",
            "## Termination Condition",
            "Never stop unless manually updated."
          ].join("\n")
        );
        writeFileSync(
          path.join(taskDir, "status.md"),
          [
            "---",
            "task_id: planned-task",
            "repository_id: repo",
            "schedule: every 1 hour",
            "task_status: active",
            "scheduler_action: continue",
            "last_execution_id: none",
            "last_execution_started_at: none",
            "last_execution_finished_at: none",
            `last_updated: ${new Date().toISOString()}`,
            "---",
            "# Scheduled Task Status",
            "",
            "## Current Status",
            "- Lifecycle state: active",
            "- Scheduler action: continue"
          ].join("\n")
        );

        return {
          sessionId: "planning-session",
          responseText: "Prepared the scheduled task documents.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );
  const router = new InteractionRouter(service);

  const turn = buildTurn("create a task running per second in repo");
  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].repositoryPath, handlerDir);
  assert.equal(calls[1].repositoryPath, repoDir);
  assert.match(calls[1].prompt, /preparing a repository-scoped scheduled task/i);
  assert.deepEqual(publisher.failed, []);
  assert.equal(publisher.started.length, 1);
  assert.equal(publisher.started[0].note, "Creating the scheduled task.");
  assert.match(publisher.completed[0], /Created scheduled task/);

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.activeRepository, undefined);

  const tasks = await service.listScheduledTasks(turn);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].repositoryId, "repo");
  assert.equal(tasks[0].scheduleDescription, "every 1 hour");
  assert.equal(tasks[0].state, "active");

  const listPublisher = createPublisher();
  await router.handleTurn(buildTurn("/codex tasks"), listPublisher);
  assert.equal(listPublisher.completed.length, 1);
  assert.match(listPublisher.completed[0], new RegExp(tasks[0].id));
  assert.match(listPublisher.completed[0], /every 1 hour/);
});

test("bound conversations keep task-like text on the live worker session instead of creating scheduled tasks", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-scheduled-task-bound-worker-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const calls = [];
  const service = new CodexBridgeService(
    buildConfig(root, handlerDir, [
      {
        id: "repo",
        path: repoDir,
        sandboxMode: "workspace-write"
      }
    ]),
    new FileSessionStore(path.join(root, "sessions.json")),
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);
        return {
          sessionId: "worker-session-1",
          responseText: "Handled as a normal live worker request.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("create a task running per hour in repo");
  await service.bindConversation(turn, "repo");

  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].repositoryPath, repoDir);
  assert.deepEqual(publisher.completed, ["Handled as a normal live worker request."]);
  assert.equal((await service.listScheduledTasks(turn)).length, 0);
});

test("runDueScheduledTasks executes due tasks and stops when status.md requests stop", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-scheduled-task-run-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const calls = [];
  const service = new CodexBridgeService(
    buildConfig(root, handlerDir, [
      {
        id: "repo",
        path: repoDir,
        sandboxMode: "workspace-write"
      }
    ]),
    new FileSessionStore(path.join(root, "sessions.json")),
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);
        if (request.repositoryPath === handlerDir) {
          return {
            sessionId: "handler-session-1",
            responseText: [
              '[[ACTION:SCHEDULE({"repositoryId":"repo","schedule":"every 1 second","taskPrompt":"check status"})]]',
              "Creating the scheduled task."
            ].join("\n"),
            rawEvents: [],
            stderrLines: []
          };
        }

        const taskDir = getOnlyTaskDir(repoDir);

        if (/preparing a repository-scoped scheduled task/i.test(request.prompt)) {
          writeFileSync(
            path.join(taskDir, "task.md"),
            [
              "---",
              "task_id: planned-task",
              "repository_id: repo",
              "schedule: every 1 second",
              "---",
              "# Scheduled Task Specification",
              "",
              "## Requirement / Description",
              "Check the repository status once.",
              "",
              "## Execution Plan",
              "Inspect status and stop when the first successful run completes.",
              "",
              "## Termination Condition",
              "Stop after the first successful execution."
            ].join("\n")
          );
          writeFileSync(
            path.join(taskDir, "status.md"),
            [
              "---",
              "task_id: planned-task",
              "repository_id: repo",
              "schedule: every 1 second",
              "task_status: active",
              "scheduler_action: continue",
              "last_execution_id: none",
              "last_execution_started_at: none",
              "last_execution_finished_at: none",
              `last_updated: ${new Date().toISOString()}`,
              "---",
              "# Scheduled Task Status"
            ].join("\n")
          );

          return {
            sessionId: "planning-session",
            responseText: "Prepared the scheduled task.",
            rawEvents: [],
            stderrLines: []
          };
        }

        writeFileSync(
          path.join(taskDir, "status.md"),
          [
            "---",
            `task_id: ${readTaskIdFromPrompt(request.prompt)}`,
            "repository_id: repo",
            "schedule: every 1 second",
            "task_status: completed",
            "scheduler_action: stop",
            `last_execution_id: ${readExecutionIdFromPrompt(request.prompt)}`,
            `last_execution_started_at: ${new Date().toISOString()}`,
            `last_execution_finished_at: ${new Date().toISOString()}`,
            `last_updated: ${new Date().toISOString()}`,
            "---",
            "# Scheduled Task Status",
            "",
            "## Current Status",
            "- Lifecycle state: completed",
            "- Scheduler action: stop",
            "",
            "## Execution Log",
            "### Completed run",
            "- Task finished successfully."
          ].join("\n")
        );

        return {
          sessionId: "execution-session",
          responseText: "Checked status and the task can stop.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("create a task running per hour in repo");
  await service.handleTurn(turn, createPublisher());

  await new Promise((resolve) => {
    setTimeout(resolve, 1_100);
  });

  const completedCount = await service.runDueScheduledTasks({
    ownerId: "test-owner"
  });

  assert.equal(completedCount, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].repositoryPath, handlerDir);
  assert.match(calls[2].prompt, /executing a repository-scoped scheduled task/i);

  const tasks = await service.listScheduledTasks(turn);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state, "completed");
  assert.equal(tasks[0].lastRunOutcome, "stopped");
  assert.equal(tasks[0].runCount, 1);
  assert.equal(tasks[0].nextRunAt, undefined);

  const statusDoc = readFileSync(tasks[0].statusDocumentPath, "utf8");
  assert.match(statusDoc, /scheduler_action: stop/);
  assert.match(statusDoc, /Execution .* completed at/);
});

test("parseBridgeCommand recognizes the tasks command", () => {
  assert.deepEqual(parseBridgeCommand("/codex tasks"), {
    kind: "tasks"
  });
});

function buildConfig(root, handlerDir, repositoryTargets, overrides = {}) {
  return {
    codexBinary: "codex",
    yoloMode: false,
    defaultRepositoryId: repositoryTargets[0].id,
    requireExplicitRepositorySelection: true,
    handlerWorkspacePath: handlerDir,
    handlerSandboxMode: "read-only",
    maxHandlerStepsPerTurn: 4,
    progressUpdates: "minimal",
    repositoryTargets,
    sessionStorePath: path.join(root, "sessions.json"),
    maxResponseChars: 3500,
    ...overrides
  };
}

function buildTurn(text) {
  return {
    platform: "slack",
    workspaceId: "T111",
    channelId: "C222",
    threadId: "1000",
    userId: "U111",
    userDisplayName: "alice",
    scope: "thread",
    text,
    attachments: [],
    receivedAt: "2026-03-28T00:00:00.000Z"
  };
}

function createPublisher() {
  return {
    started: [],
    completed: [],
    failed: [],
    async publishQueued() {},
    async publishStarted(_turn, binding, note) {
      this.started.push({
        repositoryId: binding.activeRepository?.repositoryId,
        note
      });
    },
    async publishProgress() {},
    async publishCompleted(_turn, message) {
      this.completed.push(message.text);
    },
    async publishInterrupted() {},
    async publishFailed(_turn, errorMessage) {
      this.failed.push(errorMessage);
    }
  };
}

function getOnlyTaskDir(repoDir) {
  const scheduledTaskRoot = path.join(repoDir, ".nuntius", "scheduled-tasks");
  const [taskId] = readdirSync(scheduledTaskRoot);
  return path.join(scheduledTaskRoot, taskId);
}

function readTaskIdFromPrompt(prompt) {
  const match = prompt.match(/Task id: ([^\n]+)/);
  return match?.[1] ?? "unknown-task";
}

function readExecutionIdFromPrompt(prompt) {
  const match = prompt.match(/Execution id: ([^\n]+)/);
  return match?.[1] ?? "unknown-execution";
}
