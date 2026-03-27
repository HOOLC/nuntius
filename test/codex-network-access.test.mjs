import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadRepositoryRegistry } from "../dist/config.js";
import {
  buildCodexNetworkAccessFailureMessage,
  buildCodexNetworkAccessStartNote
} from "../dist/codex-network-access.js";
import { CodexRunner } from "../dist/codex-runner.js";
import { CodexBridgeService } from "../dist/service.js";
import { FileSessionStore } from "../dist/session-store.js";
import { SerialTurnQueue } from "../dist/serial-turn-queue.js";

test("repository targets default to Codex network access with a derived workspace path", () => {
  const registry = loadRepositoryRegistry({
    inlineRepositoryTargets: [
      {
        id: "repo",
        path: "/srv/repos/repo",
        sandbox_mode: "workspace-write"
      }
    ]
  });

  assert.equal(registry.repositoryTargets[0].allowCodexNetworkAccess, true);
  assert.equal(
    registry.repositoryTargets[0].codexNetworkAccessWorkspacePath,
    path.join(os.tmpdir(), "nuntius-codex-network", "repo")
  );
});

test("network access start notes describe the remaining host prerequisites", () => {
  const note = buildCodexNetworkAccessStartNote({
    allowCodexNetworkAccess: true,
    codexNetworkAccessWorkspacePath: "/tmp/nuntius-codex-network/repo",
    sandboxMode: "workspace-write"
  });

  assert.match(note, /codex --search/);
  assert.match(note, /sandbox_workspace_write\.network_access=true/);
  assert.match(note, /chatgpt\.com/);
  assert.match(note, /resolve\/connect to external hosts/);
});

test("CodexRunner launches the app server with network-aware worker settings for new and resumed sessions", async (t) => {
  const harness = createRunnerHarness();
  t.after(() => harness.cleanup());

  const runner = new CodexRunner(harness.paths.fakeCodexPath);

  const newResult = await runner.runTurn({
    prompt: "inspect repo",
    repositoryPath: harness.paths.repoDir,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    searchEnabled: true,
    networkAccessEnabled: true,
    addDirs: [harness.paths.networkDir],
    configOverrides: ['foo="bar"']
  });
  assert.equal(newResult.sessionId, "worker-session");

  await runner.runTurn({
    prompt: "follow up",
    repositoryPath: harness.paths.repoDir,
    sandboxMode: "workspace-write",
    sessionId: "worker-session",
    approvalPolicy: "never",
    searchEnabled: true,
    networkAccessEnabled: true,
    addDirs: [harness.paths.networkDir],
    configOverrides: ['foo="bar"']
  });

  const invocations = readArgInvocations(harness.paths.argLogPath);
  assert.deepEqual(invocations[0], [
    "--search",
    "app-server",
    "-c",
    'foo="bar"',
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=true"
  ]);
  assert.deepEqual(invocations[1], [
    "--search",
    "app-server",
    "-c",
    'foo="bar"',
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=true"
  ]);

  const requests = readRequestLog(harness.paths.requestLogPath).filter(
    (message) => message.method !== "notifications/initialized" && message.method !== "initialized"
  );
  assert.equal(requests[0].method, "initialize");
  assert.equal(requests[1].method, "thread/start");
  assert.equal(requests[1].params.cwd, harness.paths.repoDir);
  assert.equal(requests[1].params.sandbox, "workspace-write");
  assert.equal(requests[1].params.approvalPolicy, "never");
  assert.equal(requests[2].method, "turn/start");
  assert.equal(requests[2].params.threadId, "worker-session");
  assert.equal(requests[2].params.input[0].text, "inspect repo");
  assert.deepEqual(requests[2].params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [harness.paths.repoDir, harness.paths.networkDir],
    readOnlyAccess: {
      type: "fullAccess"
    },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  });
  assert.equal(requests[3].method, "initialize");
  assert.equal(requests[4].method, "thread/resume");
  assert.equal(requests[4].params.threadId, "worker-session");
  assert.equal(requests[4].params.cwd, harness.paths.repoDir);
  assert.equal(requests[4].params.sandbox, "workspace-write");
  assert.equal(requests[5].method, "turn/start");
  assert.equal(requests[5].params.threadId, "worker-session");
  assert.equal(requests[5].params.input[0].text, "follow up");
  assert.deepEqual(requests[5].params.sandboxPolicy.writableRoots, [
    harness.paths.repoDir,
    harness.paths.networkDir
  ]);
});

test("CodexRunner uses Codex's dangerous bypass flag for yolo turns", async (t) => {
  const harness = createRunnerHarness();
  t.after(() => harness.cleanup());

  const runner = new CodexRunner(harness.paths.fakeCodexPath);
  await runner.runTurn({
    prompt: "inspect repo in yolo mode",
    repositoryPath: harness.paths.repoDir,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  });

  const invocations = readArgInvocations(harness.paths.argLogPath);
  assert.deepEqual(invocations[0], [
    "--dangerously-bypass-approvals-and-sandbox",
    "app-server",
    "-c",
    'approval_policy="never"'
  ]);

  const requests = readRequestLog(harness.paths.requestLogPath).filter(
    (message) => message.method !== "notifications/initialized" && message.method !== "initialized"
  );
  assert.equal(requests[1].method, "thread/start");
  assert.equal(requests[1].params.sandbox, "danger-full-access");
  assert.equal(requests[2].params.sandboxPolicy.type, "dangerFullAccess");
});

test("binding the same repository keeps the worker session until network access settings change", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-network-binding-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const config = {
    codexBinary: "codex",
    yoloMode: false,
    defaultRepositoryId: "repo",
    requireExplicitRepositorySelection: true,
    handlerWorkspacePath: root,
    handlerSandboxMode: "read-only",
    maxHandlerStepsPerTurn: 4,
    progressUpdates: "minimal",
    repositoryTargets: [
      {
        id: "repo",
        path: root,
        sandboxMode: "workspace-write",
        allowCodexNetworkAccess: true,
        codexNetworkAccessWorkspacePath: path.join(root, "network-default")
      }
    ],
    sessionStorePath: path.join(root, "sessions.json"),
    maxResponseChars: 3500
  };
  const sessionStore = new FileSessionStore(config.sessionStorePath);
  const service = new CodexBridgeService(config, sessionStore, new SerialTurnQueue(), {
    runTurn() {
      throw new Error("not used");
    }
  });
  const turn = buildTurn();

  const firstBinding = await service.bindConversation(turn, "repo");
  const withSession = {
    ...firstBinding,
    activeRepository: {
      ...firstBinding.activeRepository,
      workerSessionId: "worker-session-1",
      updatedAt: "2026-03-16T00:00:00.000Z"
    },
    updatedAt: "2026-03-16T00:00:00.000Z"
  };
  await sessionStore.upsert(withSession);

  const reboundWithoutChange = await service.bindConversation(turn, "repo");
  assert.equal(reboundWithoutChange.activeRepository?.workerSessionId, "worker-session-1");

  config.repositoryTargets[0] = {
    ...config.repositoryTargets[0],
    allowCodexNetworkAccess: false,
    codexNetworkAccessWorkspacePath: undefined
  };

  const reboundWithNetworkDisabled = await service.bindConversation(turn, "repo");
  assert.equal(reboundWithNetworkDisabled.activeRepository?.workerSessionId, undefined);
});

test("repo-bound worker turns honor workspace-write sandbox and request outbound network", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-network-worker-launch-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlerDir = path.join(root, "handler");
  const repoDir = path.join(root, "repo");
  const networkDir = path.join(root, "network");
  mkdirSync(handlerDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  const calls = [];
  const service = new CodexBridgeService(
    {
      codexBinary: "codex",
      yoloMode: false,
      defaultRepositoryId: "repo",
      requireExplicitRepositorySelection: true,
      handlerWorkspacePath: handlerDir,
      handlerSandboxMode: "read-only",
      maxHandlerStepsPerTurn: 4,
      progressUpdates: "minimal",
      repositoryTargets: [
        {
          id: "repo",
          path: repoDir,
          sandboxMode: "workspace-write",
          allowCodexNetworkAccess: true,
          codexNetworkAccessWorkspacePath: networkDir
        }
      ],
      sessionStorePath: path.join(root, "sessions.json"),
      maxResponseChars: 3500
    },
    new FileSessionStore(path.join(root, "sessions.json")),
    new SerialTurnQueue(),
    {
      async runTurn(request) {
        calls.push(request);
        return {
          sessionId: "worker-session-1",
          responseText: "Fetched remote context.",
          rawEvents: [],
          stderrLines: []
        };
      }
    }
  );

  const turn = buildTurn();
  await service.bindConversation(turn, "repo");
  await service.handleTurn(turn, createNoopPublisher());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].repositoryPath, repoDir);
  assert.equal(calls[0].sandboxMode, "workspace-write");
  assert.equal(calls[0].searchEnabled, true);
  assert.equal(calls[0].networkAccessEnabled, true);
  assert.deepEqual(calls[0].addDirs, [networkDir]);

  const status = await service.getConversationStatus(turn);
  assert.equal(status.binding?.activeRepository?.sandboxMode, "workspace-write");
  assert.equal(status.binding?.activeRepository?.workerSessionId, "worker-session-1");
});

test("worker failures with requested network access surface an explicit host-level warning", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-network-failure-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const service = new CodexBridgeService(
    {
      codexBinary: "codex",
      yoloMode: false,
      defaultRepositoryId: "repo",
      requireExplicitRepositorySelection: true,
      handlerWorkspacePath: root,
      handlerSandboxMode: "read-only",
      maxHandlerStepsPerTurn: 4,
      progressUpdates: "minimal",
      repositoryTargets: [],
      sessionStorePath: path.join(root, "sessions.json"),
      maxResponseChars: 3500
    },
    {
      async get() {
        return undefined;
      },
      async upsert() {},
      async delete() {},
      async list() {
        return [];
      }
    },
    new SerialTurnQueue(),
    {
      async runTurn() {
        throw new Error("Codex exited with code 1.\nOperation not permitted (os error 1)");
      }
    }
  );

  const binding = {
    key: {
      platform: "slack",
      workspaceId: "T111",
      channelId: "C222",
      threadId: "1000"
    },
    createdByUserId: "U111",
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    activeRepository: {
      repositoryId: "repo",
      repositoryPath: root,
      sandboxMode: "workspace-write",
      allowCodexNetworkAccess: true,
      codexNetworkAccessWorkspacePath: path.join(root, "network"),
      updatedAt: "2026-03-16T00:00:00.000Z"
    }
  };

  await assert.rejects(
    service.runWorkerTurn(buildTurn(), binding, "Fetch docs from the web.", createNoopPublisher()),
    (error) => {
      assert.match(error.message, /requested for this worker session via `codex --search`/);
      assert.match(error.message, /sandbox_workspace_write\.network_access=true/);
      assert.match(error.message, /nuntius cannot bypass those limits/);
      assert.match(error.message, /chatgpt\.com/);
      assert.match(error.message, /Operation not permitted/);
      return true;
    }
  );
});

test("network access failures call out DNS resolution blockers explicitly", () => {
  const errorMessage = buildCodexNetworkAccessFailureMessage(
    {
      allowCodexNetworkAccess: true,
      codexNetworkAccessWorkspacePath: "/tmp/nuntius-codex-network/repo"
    },
    [
      "Codex exited with code 128.",
      "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
      "fatal: Could not read from remote repository."
    ].join("\n")
  );

  assert.match(errorMessage, /DNS resolution failure/);
  assert.match(errorMessage, /git, ssh, and curl/);
  assert.match(errorMessage, /Temporary failure in name resolution/);
});

function createRunnerHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-codex-runner-"));
  const repoDir = path.join(root, "repo");
  const networkDir = path.join(root, "network");
  const argLogPath = path.join(root, "argv.jsonl");
  const requestLogPath = path.join(root, "requests.jsonl");
  const fakeCodexPath = path.join(root, "fake-codex");

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(networkDir, { recursive: true });
  writeFileSync(fakeCodexPath, buildFakeCodexScript(argLogPath, requestLogPath), { mode: 0o755 });
  chmodSync(fakeCodexPath, 0o755);

  return {
    paths: {
      root,
      repoDir,
      networkDir,
      argLogPath,
      requestLogPath,
      fakeCodexPath
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function buildFakeCodexScript(argLogPath, requestLogPath) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");

appendFileSync(${JSON.stringify(argLogPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let threadId = "worker-session";
let resumed = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function sendResult(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result
  });
}

function sendNotification(method, params) {
  send({
    jsonrpc: "2.0",
    method,
    params
  });
}

(async () => {
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    const message = JSON.parse(line);
    appendFileSync(${JSON.stringify(requestLogPath)}, JSON.stringify(message) + "\\n");

    switch (message.method) {
      case "initialize":
        sendResult(message.id, {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "linux"
        });
        break;
      case "notifications/initialized":
      case "initialized":
        break;
      case "thread/start":
        resumed = false;
        sendResult(message.id, {
          thread: {
            id: threadId
          }
        });
        sendNotification("thread/started", {
          thread: {
            id: threadId
          }
        });
        break;
      case "thread/resume":
        resumed = true;
        threadId = message.params.threadId;
        sendResult(message.id, {
          thread: {
            id: threadId
          }
        });
        break;
      case "turn/start": {
        sendResult(message.id, {
          turn: {
            id: resumed ? "turn-resume" : "turn-new",
            items: [],
            status: "inProgress",
            error: null
          }
        });
        sendNotification("turn/started", {
          threadId,
          turn: {
            id: resumed ? "turn-resume" : "turn-new",
            items: [],
            status: "inProgress",
            error: null
          }
        });
        sendNotification("item/completed", {
          threadId,
          turnId: resumed ? "turn-resume" : "turn-new",
          item: {
            type: "agentMessage",
            id: resumed ? "msg-resume" : "msg-new",
            text: resumed ? "resume ok" : "new ok",
            phase: "final_answer",
            memoryCitation: null
          }
        });
        sendNotification("turn/completed", {
          threadId,
          turn: {
            id: resumed ? "turn-resume" : "turn-new",
            items: [],
            status: "completed",
            error: null
          }
        });
        break;
      }
      default:
        sendResult(message.id, null);
        break;
    }
  }
})();
`;
}

function readArgInvocations(filePath) {
  return readJsonLines(filePath);
}

function readRequestLog(filePath) {
  return readJsonLines(filePath);
}

function readJsonLines(filePath) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildTurn() {
  return {
    platform: "slack",
    workspaceId: "T111",
    channelId: "C222",
    threadId: "1000",
    userId: "U111",
    scope: "thread",
    text: "status",
    attachments: [],
    receivedAt: "2026-03-16T00:00:00.000Z"
  };
}

function createNoopPublisher() {
  return {
    async publishQueued() {},
    async publishStarted() {},
    async publishProgress() {},
    async publishCompleted() {},
    async publishInterrupted() {},
    async publishFailed() {}
  };
}
