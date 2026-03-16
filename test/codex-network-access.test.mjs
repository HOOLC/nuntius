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

test("CodexRunner prefixes new and resumed worker sessions with --search and workspace-write network access when requested", async (t) => {
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
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    harness.paths.repoDir,
    "-c",
    'foo="bar"',
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--add-dir",
    harness.paths.networkDir,
    "-s",
    "workspace-write",
    "inspect repo"
  ]);
  assert.deepEqual(invocations[1], [
    "--search",
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "-c",
    'foo="bar"',
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--add-dir",
    harness.paths.networkDir,
    "worker-session",
    "follow up"
  ]);
});

test("binding the same repository keeps the worker session until network access settings change", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-network-binding-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const config = {
    codexBinary: "codex",
    defaultRepositoryId: "repo",
    requireExplicitRepositorySelection: true,
    handlerWorkspacePath: root,
    handlerSandboxMode: "read-only",
    maxHandlerStepsPerTurn: 4,
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

test("worker failures with requested network access surface an explicit host-level warning", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-network-failure-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const service = new CodexBridgeService(
    {
      codexBinary: "codex",
      defaultRepositoryId: "repo",
      requireExplicitRepositorySelection: true,
      handlerWorkspacePath: root,
      handlerSandboxMode: "read-only",
      maxHandlerStepsPerTurn: 4,
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
  const argLogPath = path.join(root, "argv.bin");
  const fakeCodexPath = path.join(root, "fake-codex");

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(networkDir, { recursive: true });
  writeFileSync(fakeCodexPath, buildFakeCodexScript(argLogPath), { mode: 0o755 });
  chmodSync(fakeCodexPath, 0o755);

  return {
    paths: {
      root,
      repoDir,
      networkDir,
      argLogPath,
      fakeCodexPath
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function buildFakeCodexScript(argLogPath) {
  return `#!/usr/bin/env bash
set -euo pipefail

for arg in "$@"; do
  printf '%s\\0' "$arg" >> ${JSON.stringify(argLogPath)}
done
printf '\\0' >> ${JSON.stringify(argLogPath)}

if [[ "\${2:-}" == "resume" ]]; then
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"resume ok"}}'
  printf '%s\\n' '{"type":"turn.completed"}'
  exit 0
fi

printf '%s\\n' '{"type":"thread.started","thread_id":"worker-session"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"new ok"}}'
printf '%s\\n' '{"type":"turn.completed"}'
`;
}

function readArgInvocations(filePath) {
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\u0000\u0000")
    .filter(Boolean)
    .map((entry) => entry.split("\u0000").filter(Boolean));
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
