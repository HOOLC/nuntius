import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { FeishuBot } from "../dist/feishu-bot.js";

test("probe worker reports readiness and exits cleanly", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const child = spawn(process.execPath, ["dist/feishu-bot.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NUNTIUS_CONFIG_PATH: harness.paths.configPath,
      NUNTIUS_FEISHU_WORKER_MODE: "probe"
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = await new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for probe worker exit.\nstdout:\n${stdout || "<empty>"}\nstderr:\n${stderr || "<empty>"}`
        )
      );
    }, 5_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("message", (message) => {
      if (message?.type === "probe_ready") {
        ready = true;
      }
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, ready, signal, stderr, stdout });
    });
  });

  assert.equal(result.ready, true);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
});

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
  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["message.reply"]
  );
  assert.equal(harness.records[0].body.msg_type, "text");
  assert.match(readTextContent(harness.records[0]), /\/codex/);
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.kind),
    ["reaction.create"]
  );
  assert.equal(harness.reactionRecords[0].path, "/im/v1/messages/om-dm-1/reactions");
  assert.deepEqual(harness.reactionRecords[0].body, {
    reaction_type: {
      emoji_type: "DONE"
    }
  });

  harness.resetRecords();
  bot.handleIncomingLongConnectionEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(harness.records, []);
  assert.deepEqual(harness.reactionRecords, []);
});

test("admin hotreload rebuilds and requests a supervisor reload", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const workerMessages = [];
  const bot = new FeishuBot({
    isSupervisorAvailable: () => true,
    rebuildBridge: async () => ({
      ok: true,
      output: "build ok"
    }),
    sendWorkerMessage: (message) => {
      workerMessages.push(message);
    }
  });
  await bot.refreshFeishuClient();

  harness.resetRecords();

  bot.handleIncomingLongConnectionEvent(
    buildMessageEvent({
      eventId: "evt-admin-hotreload",
      messageId: "om-admin-1",
      chatId: "oc-chat-admin-1",
      chatType: "p2p",
      text: "/codexadmin hotreload"
    })
  );

  await waitFor(() => harness.records.length === 2);
  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["message.reply", "message.reply"]
  );
  assert.match(readTextContent(harness.records[0]), /Rebuilding the Feishu bridge now/);
  assert.match(readTextContent(harness.records[1]), /Hot reload requested/);
  assert.deepEqual(workerMessages, [{ type: "request_hot_reload" }]);
  assert.deepEqual(harness.reactionRecords, []);
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
  assert.equal(harness.records[0].body.msg_type, "text");
  assert.equal(harness.records[0].body.reply_in_thread, true);
  assert.equal(readTextContent(harness.records[0]), "Codex thread");
  assert.equal(harness.records[1].path, "/im/v1/messages/om-root-1/reply");
  assert.equal(harness.records[1].body.msg_type, "text");
  assert.equal(harness.records[1].body.reply_in_thread, true);
  assert.match(readTextContent(harness.records[1]), /Bound this conversation to "nuntius"/);
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.kind),
    ["reaction.create"]
  );
  assert.equal(harness.reactionRecords[0].path, "/im/v1/messages/om-root-1/reactions");
  assert.deepEqual(harness.reactionRecords[0].body, {
    reaction_type: {
      emoji_type: "DONE"
    }
  });

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

  await waitFor(() => harness.records.some((record) => record.kind === "message.update"));
  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["message.reply", "message.update"]
  );
  assert.equal(harness.records[0].path, "/im/v1/messages/om-root-1/reply");
  assert.equal(harness.records[0].body.msg_type, "text");
  assert.equal(harness.records[0].body.reply_in_thread, true);
  assert.equal(readTextContent(harness.records[0]), "1 file change.");
  assert.equal(harness.records[1].path, "/im/v1/messages/om-message-1");
  assert.equal(harness.records[1].body.msg_type, "text");
  assert.equal(readTextContent(harness.records[1]), "Worker summary output.");
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.kind),
    ["reaction.create", "reaction.delete", "reaction.create"]
  );
  assert.equal(harness.reactionRecords[0].path, "/im/v1/messages/om-thread-user-1/reactions");
  assert.deepEqual(harness.reactionRecords[0].body, {
    reaction_type: {
      emoji_type: "HAMMER"
    }
  });
  assert.match(harness.reactionRecords[1].path, /\/im\/v1\/messages\/om-thread-user-1\/reactions\/reaction-\d+$/);
  assert.equal(harness.reactionRecords[2].path, "/im/v1/messages/om-thread-user-1/reactions");
  assert.deepEqual(harness.reactionRecords[2].body, {
    reaction_type: {
      emoji_type: "DONE"
    }
  });

  harness.resetRecords();

  bot.handleIncomingLongConnectionEvent(
    buildMessageEvent({
      eventId: "evt-thread-2",
      messageId: "om-thread-user-2",
      rootId: "om-root-1",
      chatId: "oc-chat-1",
      chatType: "group",
      text: "summarize the changes"
    })
  );

  await waitFor(() => harness.records.some((record) => record.kind === "message.update"));
  assert.deepEqual(
    harness.records.map((record) => record.kind),
    ["message.reply", "message.update"]
  );
  assert.equal(harness.records[0].body.msg_type, "text");
  assert.equal(readTextContent(harness.records[0]), "1 file change.");
  assert.equal(harness.records[1].path, "/im/v1/messages/om-message-1");
  assert.equal(harness.records[1].body.msg_type, "text");
  assert.equal(readTextContent(harness.records[1]), "Worker follow-up output.");
  assert.deepEqual(
    harness.reactionRecords.map((record) => record.kind),
    ["reaction.create", "reaction.delete", "reaction.create"]
  );
  assert.equal(harness.reactionRecords[0].path, "/im/v1/messages/om-thread-user-2/reactions");
  assert.deepEqual(harness.reactionRecords[0].body, {
    reaction_type: {
      emoji_type: "HAMMER"
    }
  });
  assert.match(harness.reactionRecords[1].path, /\/im\/v1\/messages\/om-thread-user-2\/reactions\/reaction-\d+$/);
  assert.equal(harness.reactionRecords[2].path, "/im/v1/messages/om-thread-user-2/reactions");
  assert.deepEqual(harness.reactionRecords[2].body, {
    reaction_type: {
      emoji_type: "DONE"
    }
  });

  const invocations = readInvocationLog(harness.paths.invocationLogPath);
  assert.deepEqual(invocations, ["worker:new", "resume:worker-session"]);
});

test("thread file attachments are downloaded, exposed to Codex, and returned as updated files", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const bot = new FeishuBot();
  await bot.refreshFeishuClient();

  harness.resetRecords();

  bot.handleIncomingLongConnectionEvent(
    buildMessageEvent({
      eventId: "evt-root-bind-file",
      messageId: "om-root-file",
      chatId: "oc-chat-1",
      chatType: "group",
      text: "/codex bind nuntius"
    })
  );

  await waitFor(() =>
    harness.records.some(
      (record) =>
        record.kind === "message.reply" &&
        record.body.msg_type === "text" &&
        readTextContent(record).includes('Bound this conversation to "nuntius"')
    )
  );

  harness.resetRecords();

  bot.handleIncomingLongConnectionEvent(
    buildMessageEvent({
      eventId: "evt-thread-file",
      messageId: "om-thread-file-1",
      rootId: "om-root-file",
      threadId: "omt-thread-1",
      chatId: "oc-chat-1",
      chatType: "group",
      messageType: "file",
      content: {
        file_key: "file-doc-1",
        file_name: "proposal.docx"
      }
    })
  );

  await waitFor(() =>
    harness.records.some(
      (record) => record.kind === "message.reply" && record.body.msg_type === "file"
    )
  );

  const downloaded = harness.records.find((record) => record.kind === "message.resource.get");
  assert.equal(downloaded?.query, "type=file");

  const upload = harness.records.find((record) => record.kind === "file.upload");
  assert.equal(upload?.body.file_type, "stream");
  assert.equal(upload?.body.file_name, "proposal.docx");
  assert.equal(upload?.body.file.name, "proposal.docx");
  assert.match(upload?.body.file.text, /updated by fake codex/);

  const fileReply = harness.records.find(
    (record) => record.kind === "message.reply" && record.body.msg_type === "file"
  );
  assert.deepEqual(JSON.parse(fileReply.body.content), {
    file_key: "file-uploaded-1"
  });

  const summaryReply = harness.records.find(
    (record) =>
      record.kind === "message.update" &&
      record.body.msg_type === "text" &&
      readTextContent(record) === "Worker summary output."
  );
  assert.ok(summaryReply);
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
  const reactionRecords = [];
  let nextReactionId = 1;

  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const pathName = parsedUrl.pathname.replace("/open-apis", "");
    const method = (init.method ?? "GET").toUpperCase();
    const body = await parseFetchBody(init.body);
    const record = {
      kind: classifyFeishuFetch(method, pathName),
      method,
      path: pathName,
      query: parsedUrl.searchParams.toString(),
      body
    };
    if (record.kind.startsWith("reaction.")) {
      reactionRecords.push(record);
    } else {
      records.push(record);
    }

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

    if (record.kind === "message.resource.get") {
      return new Response(Buffer.from("original docx"), {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
      });
    }

    if (record.kind === "message.reply") {
      if (record.body.msg_type === "file") {
        return jsonResponse({
          code: 0,
          msg: "ok",
          data: {
            message_id: "om-file-reply-1",
            thread_id: "omt-thread-1"
          }
        });
      }

      const rendered = summarizeRenderedMessage(record.body);
      const messageId =
        rendered === "Codex thread"
          ? "om-thread-starter-1"
          : rendered.includes("Bound this conversation")
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

    if (record.kind === "file.upload") {
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          file_key: "file-uploaded-1"
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

    if (record.kind === "reaction.create") {
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          reaction_id: `reaction-${nextReactionId++}`
        }
      });
    }

    if (record.kind === "reaction.delete") {
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: {}
      });
    }

    throw new Error(`Unexpected fetch in Feishu test harness: ${method} ${url}`);
  };

  return {
    paths: {
      root,
      configPath,
      invocationLogPath
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
      message_type: input.messageType ?? "text",
      content: JSON.stringify(
        input.content ??
          {
            text: input.text
          }
      ),
      mentions: input.mentions ?? []
    }
  };
}

function buildFakeCodexScript(invocationLogPath) {
  return `#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs");
const readline = require("node:readline");

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

function maybeUpdateAttachment(prompt) {
  const match = String(prompt).match(/path=(\\/[^\\s]+\\.docx?)/);
  const attachmentPath = match?.[1];
  if (attachmentPath && existsSync(attachmentPath)) {
    appendFileSync(attachmentPath, "updated by fake codex");
  }
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
        resumed = false;
        appendFileSync(${JSON.stringify(invocationLogPath)}, "worker:new\\n");
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
        appendFileSync(${JSON.stringify(invocationLogPath)}, "resume:" + threadId + "\\n");
        sendResult(message.id, {
          thread: {
            id: threadId
          }
        });
        break;
      case "turn/start": {
        const activeTurnId = resumed ? "turn-resume" : "turn-new";
        const prompt = message.params?.input?.[0]?.text ?? "";
        maybeUpdateAttachment(prompt);
        sendResult(message.id, {
          turn: {
            id: activeTurnId,
            items: [],
            status: "inProgress",
            error: null
          }
        });
        sendNotification("turn/started", {
          threadId,
          turn: {
            id: activeTurnId,
            items: [],
            status: "inProgress",
            error: null
          }
        });
        sendNotification("item/completed", {
          threadId,
          turnId: activeTurnId,
          item: {
            type: "fileChange",
            id: resumed ? "file-resume" : "file-new",
            changes: [
              {
                path: "README.md",
                kind: "update"
              }
            ],
            status: "applied"
          }
        });
        sendNotification("item/completed", {
          threadId,
          turnId: activeTurnId,
          item: {
            type: "agentMessage",
            id: resumed ? "msg-resume" : "msg-new",
            text: resumed ? "Worker follow-up output." : "Worker summary output.",
            phase: "final_answer",
            memoryCitation: null
          }
        });
        sendNotification("turn/completed", {
          threadId,
          turn: {
            id: activeTurnId,
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

function classifyFeishuFetch(method, pathName) {
  if (method === "POST" && pathName === "/auth/v3/tenant_access_token/internal") {
    return "auth";
  }

  if (method === "GET" && pathName === "/bot/v3/info") {
    return "bot.info";
  }

  if (method === "GET" && /\/im\/v1\/messages\/[^/]+\/resources\/[^/]+$/.test(pathName)) {
    return "message.resource.get";
  }

  if (method === "POST" && pathName === "/im/v1/files") {
    return "file.upload";
  }

  if (method === "POST" && /\/im\/v1\/messages\/[^/]+\/reply$/.test(pathName)) {
    return "message.reply";
  }

  if (method === "PUT" && /\/im\/v1\/messages\/[^/]+$/.test(pathName)) {
    return "message.update";
  }

  if (method === "POST" && /\/im\/v1\/messages\/[^/]+\/reactions$/.test(pathName)) {
    return "reaction.create";
  }

  if (method === "DELETE" && /\/im\/v1\/messages\/[^/]+\/reactions\/[^/]+$/.test(pathName)) {
    return "reaction.delete";
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

function readTextContent(record) {
  return JSON.parse(record.body.content).text;
}

function summarizeRenderedMessage(body) {
  return JSON.parse(body.content).text;
}

async function parseFetchBody(body) {
  if (!body) {
    return undefined;
  }

  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return JSON.parse(String(body));
  }

  if (typeof body.entries === "function") {
    const parsed = {};
    for (const [key, value] of body.entries()) {
      if (typeof value === "string") {
        parsed[key] = value;
        continue;
      }

      const content = Buffer.from(await value.arrayBuffer()).toString("utf8");
      parsed[key] = {
        name: value.name,
        type: value.type,
        text: content
      };
    }

    return parsed;
  }

  return body;
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
