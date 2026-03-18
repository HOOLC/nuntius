import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { SlackBot } from "../dist/slack-bot.js";

test("slash bind in a channel bootstraps a Slack thread and confirms ephemerally", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const bot = new SlackBot();
  await bot.refreshSlackClient();

  const response = createResponseRecorder();
  await bot.handleCommandRequest(
    Buffer.from(
      new URLSearchParams({
        command: "/codex",
        text: "bind nuntius",
        team_id: "T111",
        channel_id: "C222",
        user_id: "U111",
        user_name: "alice",
        response_url: "https://hooks.slack.test/response"
      }).toString()
    ),
    response
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "");

  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["auth.test", "chat.postMessage", "chat.postMessage", "response_url"]
  );
  assert.equal(harness.records[1].body.text, "Codex thread for <@U111>");
  assert.equal(harness.records[2].body.thread_ts, "1000");
  assert.match(harness.records[2].body.text, /Bound this conversation to "nuntius"/);
  assert.equal(harness.records[3].body.text, "Bound in this thread.");
  assert.deepEqual(harness.reactionRecords, []);
});

test("thread replies after bind go straight to the worker session and reuse it", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const bot = new SlackBot();
  await bot.refreshSlackClient();

  await bot.handleCommandRequest(
    Buffer.from(
      new URLSearchParams({
        command: "/codex",
        text: "bind nuntius",
        team_id: "T111",
        channel_id: "C222",
        user_id: "U111",
        user_name: "alice",
        response_url: "https://hooks.slack.test/response"
      }).toString()
    ),
    createResponseRecorder()
  );

  harness.resetRecords();

  await bot.handleEventRequest(
    Buffer.from(
      JSON.stringify({
        type: "event_callback",
        team_id: "T111",
        event_id: "evt-1",
        event: {
          type: "message",
          user: "U111",
          text: "check the repo now",
          channel: "C222",
          channel_type: "channel",
          ts: "1710000001.000200",
          thread_ts: "1000"
        }
      })
    ),
    createResponseRecorder()
  );

  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["chat.postMessage", "chat.postMessage"]
  );
  assert.equal(harness.records[0].body.thread_ts, "1000");
  assert.equal(harness.records[0].body.text, "Codex in `nuntius` updated `README.md`.");
  assert.equal(harness.records[1].body.thread_ts, "1000");
  assert.equal(harness.records[1].body.text, "Worker summary output.");
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.kind),
    ["reactions.add", "reactions.remove", "reactions.add"]
  );
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.body.name),
    ["hammer_and_wrench", "hammer_and_wrench", "white_check_mark"]
  );
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.body.timestamp),
    ["1710000001.000200", "1710000001.000200", "1710000001.000200"]
  );

  harness.resetRecords();

  await bot.handleEventRequest(
    Buffer.from(
      JSON.stringify({
        type: "event_callback",
        team_id: "T111",
        event_id: "evt-2",
        event: {
          type: "message",
          user: "U111",
          text: "summarize the changes",
          channel: "C222",
          channel_type: "channel",
          ts: "1710000002.000300",
          thread_ts: "1000"
        }
      })
    ),
    createResponseRecorder()
  );

  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["chat.postMessage", "chat.postMessage"]
  );
  assert.equal(harness.records[0].body.thread_ts, "1000");
  assert.equal(harness.records[0].body.text, "Codex in `nuntius` updated `README.md`.");
  assert.equal(harness.records[1].body.thread_ts, "1000");
  assert.equal(harness.records[1].body.text, "Worker follow-up output.");
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.kind),
    ["reactions.add", "reactions.remove", "reactions.add"]
  );
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.body.name),
    ["hammer_and_wrench", "hammer_and_wrench", "white_check_mark"]
  );
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.body.timestamp),
    ["1710000002.000300", "1710000002.000300", "1710000002.000300"]
  );

  const invocations = readInvocationLog(harness.paths.invocationLogPath);
  assert.deepEqual(invocations, ["worker:new", "resume:worker-session"]);
});

test("thread system prompts use Chinese when the stored conversation language is Chinese", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  writeFileSync(
    harness.paths.sessionStorePath,
    JSON.stringify(
      {
        bindings: [
          {
            key: {
              platform: "slack",
              workspaceId: "T111",
              channelId: "C222",
              threadId: "1000"
            },
            language: "zh",
            createdByUserId: "U111",
            createdAt: "2026-03-18T00:00:00.000Z",
            updatedAt: "2026-03-18T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    )
  );

  const bot = new SlackBot();
  await bot.refreshSlackClient();
  harness.resetRecords();

  await bot.handleEventRequest(
    Buffer.from(
      JSON.stringify({
        type: "event_callback",
        team_id: "T111",
        event_id: "evt-zh-empty",
        event: {
          type: "message",
          user: "U111",
          text: "   ",
          channel: "C222",
          channel_type: "channel",
          ts: "1710000003.000400",
          thread_ts: "1000"
        }
      })
    ),
    createResponseRecorder()
  );

  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["chat.postMessage"]
  );
  assert.equal(harness.records[0].body.thread_ts, "1000");
  assert.equal(harness.records[0].body.text, "请回复一条发给 Codex 的消息，或使用 `/codex help`。");
});

function createHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-slack-test-"));
  const repoDir = path.join(root, "repo");
  const sessionStorePath = path.join(root, "sessions.json");
  const invocationLogPath = path.join(root, "codex-invocations.jsonl");
  const configPath = path.join(root, "nuntius.toml");
  const fakeCodexPath = path.join(root, "fake-codex");

  mkdirSync(repoDir, { recursive: true });
  writeFileSync(fakeCodexPath, buildFakeCodexScript(invocationLogPath), { mode: 0o755 });
  chmodSync(fakeCodexPath, 0o755);
  writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
  writeFileSync(
    configPath,
    [
      "[bridge]",
      `codex_binary = ${JSON.stringify(fakeCodexPath)}`,
      'default_repository_id = "nuntius"',
      "require_explicit_repository_selection = true",
      `handler_workspace_path = ${JSON.stringify(repoDir)}`,
      'handler_sandbox_mode = "read-only"',
      `session_store_path = ${JSON.stringify(sessionStorePath)}`,
      "",
      "[[repository_targets]]",
      'id = "nuntius"',
      `path = ${JSON.stringify(repoDir)}`,
      'sandbox_mode = "workspace-write"',
      "",
      "[slack]",
      'bot_token = "xoxb-test"',
      'signing_secret = "secret"',
      'allowed_user_ids = ["U111"]',
      'admin_user_ids = ["U111"]'
    ].join("\n")
  );

  const previousConfigPath = process.env.NUNTIUS_CONFIG_PATH;
  process.env.NUNTIUS_CONFIG_PATH = configPath;

  const previousFetch = globalThis.fetch;
  const records = [];
  const reactionRecords = [];
  let nextTimestamp = 1000;

  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const record = {
      kind: classifyFetch(url),
      url: String(url),
      body
    };
    if (record.kind.startsWith("reactions.")) {
      reactionRecords.push(record);
    } else {
      records.push(record);
    }

    switch (record.kind) {
      case "auth.test":
        return jsonResponse({
          ok: true,
          user_id: "B999",
          team_id: "T111"
        });
      case "chat.postMessage":
        return jsonResponse({
          ok: true,
          ts: String(nextTimestamp++)
        });
      case "chat.update":
        return jsonResponse({
          ok: true
        });
      case "reactions.add":
      case "reactions.remove":
        return jsonResponse({
          ok: true
        });
      case "response_url":
        return new Response("", { status: 200 });
      default:
        throw new Error(`Unexpected fetch in Slack test harness: ${url}`);
    }
  };

  return {
    paths: {
      root,
      invocationLogPath,
      sessionStorePath
    },
    records,
    reactionRecords,
    resetRecords() {
      records.splice(0, records.length);
      reactionRecords.splice(0, reactionRecords.length);
    },
    cleanup() {
      globalThis.fetch = previousFetch;
      if (previousConfigPath === undefined) {
        delete process.env.NUNTIUS_CONFIG_PATH;
      } else {
        process.env.NUNTIUS_CONFIG_PATH = previousConfigPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function buildFakeCodexScript(invocationLogPath) {
  return `#!/usr/bin/env bash
set -euo pipefail

prompt="\${!#}"
session_id=""
if [[ "\${2:-}" == "resume" || "\${3:-}" == "resume" ]]; then
  session_id="\${@: -2:1}"
  printf '%s\\n' "resume:\${session_id}" >> ${JSON.stringify(invocationLogPath)}
else
  printf '%s\\n' 'worker:new' >> ${JSON.stringify(invocationLogPath)}
fi

if [[ -n "\${session_id}" ]]; then
  printf '%s\\n' '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"README.md","kind":"update"}]}}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Worker follow-up output."}}'
  printf '%s\\n' '{"type":"turn.completed"}'
  exit 0
fi

printf '%s\\n' '{"type":"thread.started","thread_id":"worker-session"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"README.md","kind":"update"}]}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Worker summary output."}}'
printf '%s\\n' '{"type":"turn.completed"}'
`;
}

function classifyFetch(url) {
  const value = String(url);
  if (value.endsWith("/auth.test")) {
    return "auth.test";
  }
  if (value.endsWith("/chat.postMessage")) {
    return "chat.postMessage";
  }
  if (value.endsWith("/chat.update")) {
    return "chat.update";
  }
  if (value.endsWith("/reactions.add")) {
    return "reactions.add";
  }
  if (value.endsWith("/reactions.remove")) {
    return "reactions.remove";
  }
  if (value === "https://hooks.slack.test/response") {
    return "response_url";
  }

  return "unexpected";
}

function createResponseRecorder() {
  return {
    body: "",
    headers: {},
    headersSent: false,
    statusCode: 0,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = "") {
      this.body = String(body);
      this.headersSent = true;
    }
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function readInvocationLog(filePath) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim());
}
