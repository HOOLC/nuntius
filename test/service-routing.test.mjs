import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("bound conversations keep repo access for later turns from other users in the same thread", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-bound-access-"));
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
        sandboxMode: "workspace-write",
        allowUsers: ["U111"]
      }
    ]),
    new FileSessionStore(path.join(root, "sessions.json")),
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);
        return {
          sessionId: request.sessionId ?? "worker-session-shared",
          responseText: "Worker output.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const firstTurn = buildTurn("bind the repo");
  await service.bindConversation(firstTurn, "repo");
  await service.handleTurn(firstTurn, createPublisher());

  const secondTurn = {
    ...buildTurn("follow up from another user"),
    userId: "U222",
    userDisplayName: "bob"
  };
  const secondPublisher = createPublisher();
  await service.handleTurn(secondTurn, secondPublisher);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].repositoryPath, repoDir);
  assert.equal(calls[1].sessionId, "worker-session-shared");
  assert.deepEqual(secondPublisher.failed, []);
  assert.deepEqual(secondPublisher.completed, ["Worker output."]);
});

test("worker turns expose attachment paths and return changed docx files", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-attachments-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  const attachmentDir = path.join(root, "attachments");
  const attachmentPath = path.join(attachmentDir, "draft.docx");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(attachmentDir, { recursive: true });
  writeFileSync(attachmentPath, "original docx");

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
        assert.match(request.prompt, new RegExp(escapeRegExp(attachmentPath)));
        writeFileSync(attachmentPath, "updated docx");
        return {
          sessionId: request.sessionId ?? "worker-session-attachment",
          responseText: "Updated the attachment.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = {
    ...buildTurn("update the attachment"),
    attachments: [
      {
        id: "file-1",
        kind: "file",
        name: "draft.docx",
        localPath: attachmentPath
      }
    ]
  };
  await service.bindConversation(turn, "repo");

  const publisher = createRichPublisher();
  await service.handleTurn(turn, publisher);

  assert.deepEqual(calls[0].addDirs, [attachmentDir]);
  assert.equal(publisher.completed.length, 1);
  assert.deepEqual(publisher.completed[0].attachments, [
    {
      name: "draft.docx",
      localPath: attachmentPath,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }
  ]);
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
    approvalPolicy: undefined,
    model: "handler-model-b",
    sessionConfigVersion: 2
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
    approvalPolicy: undefined,
    model: "handler-model-b",
    sessionConfigVersion: 2
  });
});

test("system replies stay in Chinese after a conversation starts in Chinese", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-language-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

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
        return {
          sessionId: request.sessionId ?? "handler-session-zh",
          responseText: JSON.stringify({
            action: "reply",
            message: "已收到。"
          }),
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );
  const router = new InteractionRouter(service);

  const conversationPublisher = createPublisher();
  await router.handleTurn(buildTurn("你好，先聊一下"), conversationPublisher);
  assert.deepEqual(conversationPublisher.completed, ["已收到。"]);

  const statusPublisher = createPublisher();
  await router.handleTurn(buildTurn("/codex status"), statusPublisher);
  assert.equal(statusPublisher.completed.length, 1);
  assert.match(statusPublisher.completed[0], /会话状态：/);
  assert.match(statusPublisher.completed[0], /可用仓库：repo/);
  assert.doesNotMatch(statusPublisher.completed[0], /Conversation status:/);

  const status = await service.getConversationStatus(buildTurn("继续"));
  assert.equal(status.binding?.language, "zh");
});

test("handler plain-text replies are delivered directly without a JSON envelope", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-handler-plain-text-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

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
      async runTurn() {
        return {
          sessionId: "handler-session-plain-text",
          responseText: "Normal handler text reply.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const publisher = createPublisher();
  await service.handleTurn(buildTurn("just answer normally"), publisher);

  assert.deepEqual(publisher.completed, ["Normal handler text reply."]);
});

test("handler can bind a repo from natural language without local parser help", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-handler-bind-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

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
        if (request.repositoryPath !== handlerDir) {
          throw new Error("worker should not run for a bind-only handler decision");
        }

        return {
          sessionId: request.sessionId ?? "handler-session-bind",
          responseText: '[[ACTION:BIND(repo)]]\nBound this conversation to "repo" via handler.',
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );
  const router = new InteractionRouter(service);

  const publisher = createPublisher();
  await router.handleTurn(buildTurn("work on repo"), publisher);

  assert.equal(publisher.failed.length, 0);
  assert.deepEqual(publisher.completed, ['Bound this conversation to "repo" via handler.']);

  const status = await service.getConversationStatus(buildTurn("status"));
  assert.equal(status.binding?.activeRepository?.repositoryId, "repo");
  assert.equal(status.binding?.handlerSessionId, "handler-session-bind");
});

test("handler action tags can bind and delegate in the same reply", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-handler-bind-delegate-"));
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
            sessionId: "handler-session-bind-delegate",
            responseText: [
              "[[ACTION:BIND(repo)]]",
              "[[ACTION:DELEGATE(Inspect the repo now.)]]",
              "Binding and handing off."
            ].join("\n"),
            rawEvents: [],
            stderrLines: []
          };
        }

        return {
          sessionId: "worker-session-bind-delegate",
          responseText: "Worker summary output.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );
  const router = new InteractionRouter(service);

  const publisher = createPublisher();
  await router.handleTurn(buildTurn("work on repo and inspect it"), publisher);

  assert.deepEqual(publisher.started, [
    {
      repositoryId: "repo",
      note: "Binding and handing off."
    }
  ]);
  assert.deepEqual(publisher.completed, ["Worker summary output."]);
  assert.equal(calls[0].repositoryPath, handlerDir);
  assert.equal(calls[1].repositoryPath, repoDir);
});

test("unbound handler turns replace legacy sessions and honor the configured sandbox", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-handler-sandbox-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const calls = [];
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
      async runTurn(request) {
        calls.push(request);
        return {
          sessionId: request.sessionId ?? "handler-session-upgraded",
          responseText: JSON.stringify({
            action: "reply",
            message: "Handler used configured sandbox."
          }),
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("check permissions");
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
    handlerSessionId: "handler-session-legacy",
    handlerConfig: {
      workspacePath: handlerDir,
      sandboxMode: "danger-full-access"
    }
  });

  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].repositoryPath, handlerDir);
  assert.equal(calls[0].sandboxMode, "read-only");
  assert.deepEqual(publisher.completed, ["Handler used configured sandbox."]);

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.handlerSessionId, "handler-session-upgraded");
  assert.deepEqual(status.binding?.handlerConfig, {
    workspacePath: handlerDir,
    sandboxMode: "read-only",
    approvalPolicy: undefined,
    model: undefined,
    sessionConfigVersion: 2
  });
});

test("yolo mode forces handler and worker turns to run with danger-full-access and no approvals", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-yolo-mode-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const calls = [];
  const service = new CodexBridgeService(
    {
      ...buildConfig(root, handlerDir, [
        {
          id: "repo",
          path: repoDir,
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request"
        }
      ]),
      yoloMode: true
    },
    new FileSessionStore(path.join(root, "sessions.json")),
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);
        if (calls.length === 1) {
          return {
            sessionId: "handler-session-yolo",
            responseText: "[[ACTION:BIND(repo)]][[ACTION:DELEGATE(run the task)]]",
            rawEvents: [],
            stderrLines: []
          };
        }

        return {
          sessionId: "worker-session-yolo",
          responseText: "Worker used yolo mode.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("work on repo");
  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].repositoryPath, handlerDir);
  assert.equal(calls[0].sandboxMode, "danger-full-access");
  assert.equal(calls[0].approvalPolicy, "never");
  assert.equal(calls[1].repositoryPath, repoDir);
  assert.equal(calls[1].sandboxMode, "danger-full-access");
  assert.equal(calls[1].approvalPolicy, "never");
  assert.deepEqual(publisher.completed, ["Worker used yolo mode."]);

  const status = await service.getConversationStatus(turn);
  assert.deepEqual(status.binding?.handlerConfig, {
    workspacePath: handlerDir,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    model: undefined,
    sessionConfigVersion: 2
  });
  assert.equal(status.binding?.activeRepository?.sandboxMode, "danger-full-access");
  assert.equal(status.binding?.activeRepository?.approvalPolicy, "never");
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

test("heartbeat updates refresh the working indicator when the publisher supports it", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-heartbeat-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalDateNow = Date.now;

  let now = 0;
  let intervalCallback;

  globalThis.setInterval = ((callback) => {
    intervalCallback = callback;
    return 1;
  });
  globalThis.clearInterval = (() => undefined);
  Date.now = () => now;

  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Date.now = originalDateNow;
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

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
        now = 20_000;
        intervalCallback?.();
        await new Promise((resolve) => setImmediate(resolve));

        now = 40_000;
        intervalCallback?.();
        await new Promise((resolve) => setImmediate(resolve));

        request.onEvent?.({
          type: "item.completed",
          item: {
            type: "file_change",
            changes: [
              {
                path: path.join(repoDir, "README.md"),
                kind: "update"
              }
            ]
          }
        });

        return {
          sessionId: "worker-session-1",
          responseText: "Done.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("inspect the repo");
  await service.bindConversation(turn, "repo");

  const publisher = createPublisher();
  publisher.workingIndicators = [];
  publisher.refreshWorkingIndicator = async () => {
    publisher.workingIndicators.push("refresh");
  };
  publisher.hideWorkingIndicator = async () => {
    publisher.workingIndicators.push("hide");
  };

  await service.handleTurn(turn, publisher);

  assert.deepEqual(publisher.workingIndicators, ["refresh", "refresh", "hide"]);
  assert.equal(
    publisher.progress.some((message) => message.includes("still working")),
    false
  );
  assert.deepEqual(publisher.progress, []);
});

test("non-zero command exits do not emit progress noise", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-command-exit-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

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
          type: "item.completed",
          item: {
            type: "command_execution",
            exit_code: 1
          }
        });
        request.onEvent?.({
          type: "item.completed",
          item: {
            type: "file_change",
            changes: [
              {
                path: path.join(repoDir, "README.md"),
                kind: "update"
              }
            ]
          }
        });

        return {
          sessionId: "worker-session-1",
          responseText: "Done.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("inspect the repo");
  await service.bindConversation(turn, "repo");

  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.equal(
    publisher.progress.some((message) => message.includes("saw a command exit with code")),
    false
  );
  assert.deepEqual(publisher.progress, []);
});

test("absolute paths are stripped from progress and final replies", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-sanitize-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  const attachmentPath = path.join(root, "attachments", "draft.docx");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

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
          type: "item.completed",
          item: {
            type: "agent_message",
            text: `Editing ${attachmentPath}`
          }
        });

        return {
          sessionId: "worker-session-1",
          responseText: `Saved changes to ${attachmentPath}`,
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn("update the draft");
  await service.bindConversation(turn, "repo");

  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.deepEqual(publisher.progress, ["Editing draft.docx"]);
  assert.deepEqual(publisher.completed, ["Saved changes to draft.docx"]);
  assert.equal(publisher.progress.some((message) => message.includes(root)), false);
  assert.equal(publisher.completed.some((message) => message.includes(root)), false);
});

test("absolute paths are stripped from surfaced failures", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-service-sanitize-error-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  const attachmentPath = path.join(root, "attachments", "draft.docx");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

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
      async runTurn() {
        throw new Error(`Could not open ${attachmentPath}`);
      }
    }
  );

  const turn = buildTurn("update the draft");
  await service.bindConversation(turn, "repo");

  const publisher = createPublisher();
  await service.handleTurn(turn, publisher);

  assert.deepEqual(publisher.failed, ["Could not open draft.docx"]);
  assert.equal(publisher.failed.some((message) => message.includes(root)), false);
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
    yoloMode: false,
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

function createRichPublisher() {
  return {
    async publishQueued() {},
    async publishStarted() {},
    async publishProgress() {},
    completed: [],
    async publishCompleted(_turn, message) {
      this.completed.push(message);
    },
    async publishInterrupted() {},
    async publishFailed() {}
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
