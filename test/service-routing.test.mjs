import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexTurnInterruptedError } from "../dist/codex-runner.js";
import { InteractionRouter, parseBridgeCommand } from "../dist/interaction-router.js";
import { CodexBridgeService } from "../dist/service.js";
import { FileSessionStore } from "../dist/session-store.js";
import { SerialTurnQueue } from "../dist/serial-turn-queue.js";

test("bound conversations route follow-up turns directly to the worker session", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-routing-"));
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
          sessionId: request.sessionId ?? "worker-session-1",
          responseText: request.sessionId ? "Worker follow-up output." : "Worker summary output.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const firstTurn = buildTurn("check the repo now");
  await service.bindConversation(firstTurn, "repo");

  const firstPublisher = createPublisher();
  await service.handleTurn(firstTurn, firstPublisher);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].repositoryPath, repoDir);
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(firstPublisher.started.length, 1);
  assert.deepEqual(firstPublisher.completed, ["Worker summary output."]);

  const statusAfterFirstTurn = await service.getConversationStatus(firstTurn);
  assert.equal(statusAfterFirstTurn.binding?.handlerSessionId, undefined);
  assert.equal(statusAfterFirstTurn.binding?.activeRepository?.workerSessionId, "worker-session-1");
  assert.ok(calls.every((call) => call.repositoryPath !== handlerDir));

  const secondPublisher = createPublisher();
  await service.handleTurn(buildTurn("summarize the changes"), secondPublisher);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].repositoryPath, repoDir);
  assert.equal(calls[1].sessionId, "worker-session-1");
  assert.deepEqual(secondPublisher.completed, ["Worker follow-up output."]);
  assert.ok(calls.every((call) => call.repositoryPath !== handlerDir));
});

test("explicit rebinding clears the old worker session and routes later turns to the new repo", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-rebind-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoADir = path.join(root, "repo-a");
  const repoBDir = path.join(root, "repo-b");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoADir, { recursive: true });
  mkdirSync(repoBDir, { recursive: true });

  const calls = [];
  const service = new CodexBridgeService(
    buildConfig(root, handlerDir, [
      {
        id: "repo-a",
        path: repoADir,
        sandboxMode: "workspace-write"
      },
      {
        id: "repo-b",
        path: repoBDir,
        sandboxMode: "workspace-write"
      }
    ]),
    new FileSessionStore(path.join(root, "sessions.json")),
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);

        if (request.repositoryPath === repoADir) {
          return {
            sessionId: request.sessionId ?? "worker-session-a",
            responseText: "Repo A output.",
            rawEvents: [],
            stderrLines: []
          };
        }

        return {
          sessionId: request.sessionId ?? "worker-session-b",
          responseText: "Repo B output.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("inspect repo a");
  await service.bindConversation(turn, "repo-a");
  await service.handleTurn(turn, createPublisher());

  const rebound = await service.bindConversation(turn, "repo-b");
  assert.equal(rebound.activeRepository?.repositoryId, "repo-b");
  assert.equal(rebound.activeRepository?.workerSessionId, undefined);

  const secondPublisher = createPublisher();
  await service.handleTurn(buildTurn("inspect repo b"), secondPublisher);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].repositoryPath, repoADir);
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[1].repositoryPath, repoBDir);
  assert.equal(calls[1].sessionId, undefined);
  assert.deepEqual(secondPublisher.completed, ["Repo B output."]);

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.activeRepository?.repositoryId, "repo-b");
  assert.equal(status.binding?.activeRepository?.workerSessionId, "worker-session-b");
});

test("reconcileSessionBindings reloads persisted handler and worker settings from current config", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-reconcile-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDirA = path.join(root, "handler-a");
  const handlerDirB = path.join(root, "handler-b");
  const repoDirA = path.join(root, "repo-a");
  const repoDirB = path.join(root, "repo-b");
  mkdirSync(handlerDirA, { recursive: true });
  mkdirSync(handlerDirB, { recursive: true });
  mkdirSync(repoDirA, { recursive: true });
  mkdirSync(repoDirB, { recursive: true });

  const config = buildConfig(root, handlerDirA, [
    {
      id: "repo",
      path: repoDirA,
      sandboxMode: "workspace-write",
      model: "repo-model-a"
    }
  ]);
  config.handlerModel = "handler-model-a";

  const sessionStore = new FileSessionStore(path.join(root, "sessions.json"));
  const service = new CodexBridgeService(
    config,
    sessionStore,
    new SerialTurnQueue(),
    {
      async runTurn() {
        throw new Error("not used");
      }
    }
  );

  const turn = buildTurn("inspect repo");
  const initialBinding = await service.bindConversation(turn, "repo");
  await sessionStore.upsert({
    ...initialBinding,
    handlerSessionId: "handler-session-1",
    handlerConfig: {
      workspacePath: handlerDirA,
      sandboxMode: "read-only",
      model: "handler-model-a"
    },
    activeRepository: {
      ...initialBinding.activeRepository,
      model: "repo-model-a",
      workerSessionId: "worker-session-1",
      updatedAt: "2026-03-16T00:00:00.000Z"
    },
    updatedAt: "2026-03-16T00:00:00.000Z"
  });

  config.handlerWorkspacePath = handlerDirB;
  config.handlerModel = "handler-model-b";
  config.repositoryTargets[0] = {
    ...config.repositoryTargets[0],
    path: repoDirB,
    model: "repo-model-b"
  };

  const summary = await service.reconcileSessionBindings();
  assert.deepEqual(summary, {
    totalBindings: 1,
    updatedBindings: 1,
    clearedHandlerSessions: 1,
    clearedWorkerSessions: 1,
    droppedRepositoryBindings: 0
  });

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.handlerSessionId, undefined);
  assert.deepEqual(status.binding?.handlerConfig, {
    workspacePath: handlerDirB,
    sandboxMode: "read-only",
    model: "handler-model-b"
  });
  assert.equal(status.binding?.activeRepository?.repositoryPath, repoDirB);
  assert.equal(status.binding?.activeRepository?.model, "repo-model-b");
  assert.equal(status.binding?.activeRepository?.workerSessionId, undefined);
});

test("stale handler sessions are not resumed after handler config changes", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-handler-refresh-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDirA = path.join(root, "handler-a");
  const handlerDirB = path.join(root, "handler-b");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDirA, { recursive: true });
  mkdirSync(handlerDirB, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const calls = [];
  const config = buildConfig(root, handlerDirA, [
    {
      id: "repo",
      path: repoDir,
      sandboxMode: "workspace-write"
    }
  ]);
  config.handlerModel = "handler-model-a";

  const sessionStore = new FileSessionStore(path.join(root, "sessions.json"));
  const service = new CodexBridgeService(
    config,
    sessionStore,
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);
        return {
          sessionId: request.sessionId ?? "handler-session-2",
          responseText: JSON.stringify({
            action: "reply",
            message: "Handled with fresh config."
          }),
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("what should I do?");
  await sessionStore.upsert({
    key: {
      platform: turn.platform,
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadId: turn.threadId
    },
    createdByUserId: turn.userId,
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    handlerSessionId: "handler-session-1",
    handlerConfig: {
      workspacePath: handlerDirA,
      sandboxMode: "read-only",
      model: "handler-model-a"
    }
  });

  config.handlerWorkspacePath = handlerDirB;
  config.handlerModel = "handler-model-b";

  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].repositoryPath, handlerDirB);
  assert.equal(calls[0].model, "handler-model-b");
  assert.deepEqual(publisher.completed, ["Handled with fresh config."]);

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.handlerSessionId, "handler-session-2");
  assert.deepEqual(status.binding?.handlerConfig, {
    workspacePath: handlerDirB,
    sandboxMode: "read-only",
    model: "handler-model-b"
  });
});

test("resetState context clears Codex sessions but keeps the repository binding", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-reset-context-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const sessionStore = new FileSessionStore(path.join(root, "sessions.json"));
  const service = new CodexBridgeService(
    buildConfig(root, handlerDir, [
      {
        id: "repo",
        path: repoDir,
        sandboxMode: "workspace-write"
      }
    ]),
    sessionStore,
    new SerialTurnQueue(),
    {
      async runTurn() {
        throw new Error("not used");
      }
    }
  );

  const turn = buildTurn("start fresh");
  const binding = await service.bindConversation(turn, "repo");
  await sessionStore.upsert({
    ...binding,
    handlerSessionId: "handler-session-1",
    handlerConfig: {
      workspacePath: handlerDir,
      sandboxMode: "read-only"
    },
    activeRepository: {
      ...binding.activeRepository,
      workerSessionId: "worker-session-1",
      updatedAt: "2026-03-16T00:00:00.000Z"
    },
    updatedAt: "2026-03-16T00:00:00.000Z"
  });

  await service.resetState(turn, "context");

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.handlerSessionId, undefined);
  assert.equal(status.binding?.handlerConfig, undefined);
  assert.equal(status.binding?.activeRepository?.repositoryId, "repo");
  assert.equal(status.binding?.activeRepository?.workerSessionId, undefined);
});

test("interrupt commands bypass the queue and stop the active worker turn", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-interrupt-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const runnerStarted = createDeferred();
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
        request.onEvent?.({
          type: "thread.started",
          thread_id: "worker-session-1"
        });
        runnerStarted.resolve();

        await new Promise((_resolve, reject) => {
          const abort = () => {
            request.signal?.removeEventListener("abort", abort);
            reject(new CodexTurnInterruptedError(undefined, "worker-session-1"));
          };

          if (request.signal?.aborted) {
            abort();
            return;
          }

          request.signal?.addEventListener("abort", abort, { once: true });
        });

        throw new Error("unreachable");
      }
    }
  );

  const router = new InteractionRouter(service);
  const turn = buildTurn("inspect the repo");
  await service.bindConversation(turn, "repo");

  const activePublisher = createPublisher();
  const activePromise = router.handleTurn(turn, activePublisher);
  await runnerStarted.promise;

  const interruptPublisher = createPublisher();
  const interruptPromise = router.handleTurn(buildTurn("/codex interrupt"), interruptPublisher);
  const interruptRace = await Promise.race([
    interruptPromise.then(() => "completed"),
    new Promise((resolve) => {
      setTimeout(() => resolve("timed_out"), 200);
    })
  ]);

  if (interruptRace === "timed_out") {
    await service.interruptConversation(turn);
    await activePromise;
    assert.fail("interrupt command was queued behind the active worker turn");
  }

  await interruptPromise;
  await activePromise;

  assert.deepEqual(interruptPublisher.completed, [
    'Interrupt requested for the active worker turn for "repo".'
  ]);
  assert.deepEqual(activePublisher.interrupted, ["Interrupted the active Codex turn."]);
  assert.deepEqual(activePublisher.failed, []);

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.activeRepository?.workerSessionId, "worker-session-1");
});

test("parseBridgeCommand maps clear commands to a fresh-context reset", () => {
  assert.deepEqual(parseBridgeCommand("/codex clear"), {
    kind: "reset",
    scope: "context"
  });
  assert.deepEqual(parseBridgeCommand("/codex reset context"), {
    kind: "reset",
    scope: "context"
  });
  assert.deepEqual(parseBridgeCommand("/codex interrupt"), {
    kind: "interrupt"
  });
  assert.deepEqual(parseBridgeCommand("/codex stop"), {
    kind: "interrupt"
  });
});

function buildConfig(root, handlerDir, repositoryTargets) {
  return {
    codexBinary: "codex",
    defaultRepositoryId: repositoryTargets[0].id,
    requireExplicitRepositorySelection: true,
    handlerWorkspacePath: handlerDir,
    handlerSandboxMode: "read-only",
    maxHandlerStepsPerTurn: 4,
    repositoryTargets,
    sessionStorePath: path.join(root, "sessions.json"),
    maxResponseChars: 3500
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
    receivedAt: "2026-03-16T00:00:00.000Z"
  };
}

function createPublisher() {
  return {
    queued: 0,
    started: [],
    progress: [],
    completed: [],
    interrupted: [],
    failed: [],
    async publishQueued() {
      this.queued += 1;
    },
    async publishStarted(_turn, binding, note) {
      this.started.push({
        repositoryId: binding.activeRepository?.repositoryId,
        note
      });
    },
    async publishProgress(_turn, message) {
      this.progress.push(message);
    },
    async publishCompleted(_turn, message) {
      this.completed.push(message.text);
    },
    async publishInterrupted(_turn, message) {
      this.interrupted.push(message);
    },
    async publishFailed(_turn, errorMessage) {
      this.failed.push(errorMessage);
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve,
    reject
  };
}
