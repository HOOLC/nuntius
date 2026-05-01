import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexRunner } from "../dist/codex-runner.js";

test("CodexRunner registers dynamic tools and answers tool call requests", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-codex-runner-tools-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const fakeCodexPath = path.join(root, "fake-codex");
  const requestLogPath = path.join(root, "requests.jsonl");
  const responseLogPath = path.join(root, "tool-responses.jsonl");
  writeFileSync(fakeCodexPath, buildFakeCodexScript(requestLogPath, responseLogPath), {
    mode: 0o755
  });
  chmodSync(fakeCodexPath, 0o755);

  const runner = new CodexRunner(fakeCodexPath);
  const toolCalls = [];
  const dynamicTool = {
    namespace: "nuntius",
    name: "wake_after",
    description: "Request a later worker wake-up.",
    inputSchema: {
      type: "object",
      properties: {
        duration: {
          type: "string"
        }
      },
      required: ["duration"],
      additionalProperties: false
    }
  };

  const result = await runner.runTurn({
    prompt: "wait five minutes",
    repositoryPath: root,
    sandboxMode: "read-only",
    dynamicTools: [dynamicTool],
    onDynamicToolCall(call) {
      toolCalls.push(call);
      return {
        contentItems: [
          {
            type: "inputText",
            text: "wake-up recorded"
          }
        ],
        success: true
      };
    }
  });

  assert.equal(result.sessionId, "thread-tools");
  assert.equal(result.responseText, "done");
  assert.deepEqual(toolCalls, [
    {
      threadId: "thread-tools",
      turnId: "turn-tools",
      callId: "call-1",
      namespace: "nuntius",
      tool: "wake_after",
      arguments: {
        duration: "5m"
      }
    }
  ]);

  const requests = readJsonLines(requestLogPath).filter(
    (message) => message.method !== "notifications/initialized" && message.method !== "initialized"
  );
  assert.equal(requests[0].method, "initialize");
  assert.deepEqual(requests[0].params.capabilities, {
    experimentalApi: true
  });
  assert.equal(requests[1].method, "thread/start");
  assert.deepEqual(requests[1].params.dynamicTools, [dynamicTool]);

  const toolResponses = readJsonLines(responseLogPath);
  assert.deepEqual(toolResponses, [
    {
      jsonrpc: "2.0",
      id: 100,
      result: {
        contentItems: [
          {
            type: "inputText",
            text: "wake-up recorded"
          }
        ],
        success: true
      }
    }
  ]);
});

function buildFakeCodexScript(requestLogPath, responseLogPath) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

const threadId = "thread-tools";
const turnId = "turn-tools";

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

function completeTurn() {
  sendNotification("item/completed", {
    threadId,
    turnId,
    item: {
      type: "agentMessage",
      id: "msg-tools",
      text: "done",
      phase: "final_answer",
      memoryCitation: null
    }
  });
  sendNotification("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      items: [],
      status: "completed",
      error: null
    }
  });
}

(async () => {
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    const message = JSON.parse(line);
    appendFileSync(${JSON.stringify(requestLogPath)}, JSON.stringify(message) + "\\n");

    if (message.id === 100 && ("result" in message || "error" in message)) {
      appendFileSync(${JSON.stringify(responseLogPath)}, JSON.stringify(message) + "\\n");
      completeTurn();
      continue;
    }

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
        sendNotification("thread/started", {
          thread: {
            id: threadId
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
        sendNotification("turn/started", {
          threadId,
          turn: {
            id: turnId,
            items: [],
            status: "inProgress",
            error: null
          }
        });
        send({
          jsonrpc: "2.0",
          id: 100,
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-1",
            namespace: "nuntius",
            tool: "wake_after",
            arguments: {
              duration: "5m"
            }
          }
        });
        break;
      default:
        sendResult(message.id, null);
        break;
    }
  }
})();
`;
}

function readJsonLines(filePath) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
