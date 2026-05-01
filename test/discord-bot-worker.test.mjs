import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationThreadFromChannel,
  createConversationThreadFromMessage
} from "../dist/discord-thread-creation.js";

test("Discord mention-created conversations start a thread from the user message", async () => {
  const calls = [];
  const thread = { id: "thread-1" };
  const message = {
    async startThread(options) {
      calls.push(options);
      return thread;
    }
  };

  const result = await createConversationThreadFromMessage(message, {
    userLabel: "alice",
    promptSeed: "inspect the repo",
    language: "en",
    threadNamePrefix: "codex",
    threadAutoArchiveDuration: 60
  });

  assert.equal(result, thread);
  assert.equal(calls.length, 1);
  assert.match(calls[0].name, /^codex-/);
  assert.equal(calls[0].autoArchiveDuration, 60);
  assert.equal(calls[0].reason, "Codex conversation created for alice");
});

test("Discord slash-created conversations still use a bot starter message", async () => {
  const sentMessages = [];
  const threadOptions = [];
  const thread = { id: "thread-1" };
  const channel = {
    async send(message) {
      sentMessages.push(message);
      return {
        async startThread(options) {
          threadOptions.push(options);
          return thread;
        }
      };
    }
  };

  const result = await createConversationThreadFromChannel(channel, {
    userLabel: "alice",
    promptSeed: "inspect the repo",
    language: "en",
    threadNamePrefix: "codex",
    threadAutoArchiveDuration: 60
  });

  assert.equal(result, thread);
  assert.deepEqual(sentMessages, [{ content: "Codex thread for alice" }]);
  assert.equal(threadOptions.length, 1);
  assert.match(threadOptions[0].name, /^codex-/);
});
