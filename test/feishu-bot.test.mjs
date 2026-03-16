import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { FeishuBot } from "../dist/feishu-bot.js";

test("duplicate long connection events are ignored", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const bot = new FeishuBot();
  await bot.refreshFeishuClient();

  harness.resetRecords();

  const event = buildMessageEvent({
    eventId: "evt-dm-1",
    messageId: "om-dm-1",
    chatId: "oc-chat-dm-1",
    chatType: "p2p",
    text: "/codex help"
  });
  bot.handleIncomingLongConnectionEvent(event);

  await waitFor(() => harness.records.length === 1);
  assert.equal(harness.records[0].kind, "message.reply");

  harness.resetRecords();
  bot.handleIncomingLongConnectionEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(harness.records, []);
});

test("group bind bootstraps a Feishu thread and thread replies reuse the worker session", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const bot = new FeishuBot();
  await bot.refreshFeishuClient();

  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["auth", "bot.info"]
  );

  harness.resetRecords();

  bot.handleIncomingLongConnectionEvent(
    buildMessageEvent({
      eventId: "evt-root-bind",
      messageId: "om-root-1",
      chatId: "oc-chat-1",
      chatType: "group",
      text: "/codex bind nuntius"
    })
  );

  await waitFor(() => harness.records.length === 2);
  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["message.reply", "message.reply"]
  );
  assert.equal(harness.records[0].path, "/im/v1/messages/om-root-1/reply");
  assert.equal(harness.records[0].body.reply_in_thread, true);
  assert.equal(JSON.parse(harness.records[0].body.content).text, "Codex thread");
  assert.equal(harness.records[1].path, "/im/v1/messages/om-root-1/reply");
  assert.equal(harness.records[1].body.reply_in_thread, true);
  assert.match(JSON.parse(harness.records[1].body.content).text, /Bound this conversation to "nuntius"/);

  harness.resetRecords();

  bot.handleIncomingLongConnectionEvent(
    buildMessageEvent({
      eventId: "evt-thread-1",
      messageId: "om-thread-user-1",
      rootId: "om-root-1",
      threadId: "omt-thread-1",
      chatId: "oc-chat-1",
      chatType: "group",
      text: "check the repo now"
    })
  );

  await waitFor(() => harness.records.length === 4);
  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["message.reply", "message.update", "message.update", "message.reply"]
  );
  assert.equal(harness.records[0].path, "/im/v1/messages/om-root-1/reply");
  assert.equal(harness.records[0].body.reply_in_thread, true);
  assert.match(JSON.parse(harness.records[0].body.content).text, /^Started/);
  assert.equal(harness.records[1].path, "/im/v1/messages/om-status-1");
  assert.match(JSON.parse(harness.records[1].body.content).text, /^Working/);
  assert.match(JSON.parse(harness.records[1].body.content).text, /README\.md/);
  assert.equal(harness.records[2].path, "/im/v1/messages/om-status-1");
  assert.match(JSON.parse(harness.records[2].body.content).text, /^Completed/);
  assert.equal(harness.records[3].path, "/im/v1/messages/om-root-1/reply");
  assert.equal(JSON.parse(harness.records[3].body.content).text, "Worker summary output.");

  harness.resetRecords();

  bot.handleIncomingLongConnectionEvent(
    buildMessageEvent({
      eventId: "evt-thread-2",
      messageId: "om-thread-user-2",
      rootId: "om-root-1",
      threadId: "omt-thread-1",
      chatId: "oc-chat-1",
      chatType: "group",
      text: "summarize the changes"
    })
  );

  await waitFor(() => harness.records.length === 4);
  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["message.reply", "message.update", "message.update", "message.reply"]
  );
  assert.match(JSON.parse(harness.records[0].body.content).text, /session=worker-session/);
  assert.equal(JSON.parse(harness.records[3].body.content).text, "Worker follow-up output.");

  const invocations = readInvocationLog(harness.paths.invocationLogPath);
  assert.deepEqual(invocations, ["worker:new", "resume:worker-session"]);
});

function createHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-feishu-test-"));
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
      "[feishu]",
      'app_id = "cli-test"',
      'app_secret = "secret-test"',
      'allowed_open_ids = ["ou-user-1"]',
      'admin_open_ids = ["ou-user-1"]'
    ].join("\n")
  );

  const previousConfigPath = process.env.NUNTIUS_CONFIG_PATH;
  process.env.NUNTIUS_CONFIG_PATH = configPath;

  const previousFetch = globalThis.fetch;
  const records = [];

  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const pathName = parsedUrl.pathname.replace("/open-apis", "");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const record = {
      kind: classifyFeishuFetch(method, pathName),
      method,
      path: pathName,
      query: parsedUrl.searchParams.toString(),
      body
    };
    records.push(record);

    if (record.kind === "auth") {
      return jsonResponse({
        code: 0,
        msg: "ok",
        tenant_access_token: "tenant-token",
        expire: 7200
      });
    }

    if (record.kind === "bot.info") {
      return jsonResponse({
        code: 0,
        msg: "ok",
        bot: {
          open_id: "ou-bot-1"
        }
      });
    }

    if (record.kind === "message.reply") {
      const text = JSON.parse(record.body.content).text;
      const messageId =
        text === "Codex thread"
          ? "om-thread-starter-1"
          : text.startsWith("Started")
            ? "om-status-1"
            : text.startsWith("Bound this conversation")
              ? "om-bind-confirmation"
              : "om-message-1";

      return jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          message_id: messageId,
          thread_id: "omt-thread-1"
        }
      });
    }

    if (record.kind === "message.update") {
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          message_id: pathName.split("/").at(-1)
        }
      });
    }

    throw new Error(`Unexpected fetch in Feishu test harness: ${method} ${url}`);
  };

  return {
    paths: {
      root,
      invocationLogPath
    },
    records,
    resetRecords() {
      records.splice(0, records.length);
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

function buildMessageEvent(input) {
  return {
    event_id: input.eventId,
    event_type: "im.message.receive_v1",
    create_time: "1710000000000",
    token: "verify-token",
    app_id: "cli-test",
    tenant_key: "tenant-1",
    sender: {
      sender_id: {
        open_id: "ou-user-1"
      },
      sender_type: "user",
      tenant_key: "tenant-1"
    },
    message: {
      message_id: input.messageId,
      root_id: input.rootId,
      parent_id: input.rootId,
      create_time: "1710000000000",
      update_time: "1710000000000",
      chat_id: input.chatId,
      thread_id: input.threadId,
      chat_type: input.chatType,
      message_type: "text",
      content: JSON.stringify({
        text: input.text
      }),
      mentions: input.mentions ?? []
    }
  };
}

function buildFakeCodexScript(invocationLogPath) {
  return `#!/usr/bin/env bash
set -euo pipefail

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

function classifyFeishuFetch(method, pathName) {
  if (method === "POST" && pathName === "/auth/v3/tenant_access_token/internal") {
    return "auth";
  }

  if (method === "GET" && pathName === "/bot/v3/info") {
    return "bot.info";
  }

  if (method === "POST" && /\/im\/v1\/messages\/[^/]+\/reply$/.test(pathName)) {
    return "message.reply";
  }

  if (method === "PUT" && /\/im\/v1\/messages\/[^/]+$/.test(pathName)) {
    return "message.update";
  }

  return "unexpected";
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

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for Feishu bot activity.");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
