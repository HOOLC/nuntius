import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexRunner, CodexTurnInterruptedError } from "../dist/codex-runner.js";

test("CodexRunner interrupts the active Codex process and preserves the session id", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-runner-interrupt-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repoDir = path.join(root, "repo");
  const fakeCodexPath = path.join(root, "fake-codex");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(fakeCodexPath, buildInterruptibleCodexScript(), {
    mode: 0o755
  });
  chmodSync(fakeCodexPath, 0o755);

  const runner = new CodexRunner(fakeCodexPath);
  const controller = new AbortController();
  const turn = runner.runTurn({
    prompt: "wait for an interrupt",
    repositoryPath: repoDir,
    sandboxMode: "workspace-write",
    signal: controller.signal
  });

  await delay(100);
  controller.abort();

  await assert.rejects(turn, (error) => {
    assert.ok(error instanceof CodexTurnInterruptedError);
    assert.equal(error.sessionId, "worker-session");
    assert.equal(error.message, "Interrupted the active Codex turn.");
    return true;
  });
});

function buildInterruptibleCodexScript() {
  return `#!/usr/bin/env node
const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let threadId = "worker-session";
let turnId = "worker-turn";

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

(async () => {
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    const message = JSON.parse(line);
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
        sendResult(message.id, {
          thread: {
            id: threadId
          }
        });
        send({
          jsonrpc: "2.0",
          method: "thread/started",
          params: {
            thread: {
              id: threadId
            }
          }
        });
        break;
      case "turn/start":
        sendResult(message.id, {
          turn: {
            id: turnId,
            items: [],
            status: "inProgress",
            error: null
          }
        });
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: {
            threadId,
            turn: {
              id: turnId,
              items: [],
              status: "inProgress",
              error: null
            }
          }
        });
        break;
      case "turn/interrupt":
        sendResult(message.id, null);
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              items: [],
              status: "interrupted",
              error: null
            }
          }
        });
        process.exit(0);
        break;
      default:
        sendResult(message.id, null);
        break;
    }
  }
})();
`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
