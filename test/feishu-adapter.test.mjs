import assert from "node:assert/strict";
import test from "node:test";

import { FeishuAdapter } from "../dist/adapters/feishu.js";

test("Feishu refreshes a single working placeholder and replaces it with real progress", async () => {
  const postedMessages = [];
  const updatedMessages = [];
  let acknowledged = 0;

  const adapter = new FeishuAdapter({
    async handleTurn(turn, publisher) {
      assert.equal(acknowledged, 1);

      await publisher.refreshWorkingIndicator?.(turn);
      assert.equal(postedMessages.length, 1);
      assert.equal(updatedMessages.length, 0);

      await publisher.refreshWorkingIndicator?.(turn);
      assert.equal(postedMessages.length, 1);
      assert.equal(updatedMessages.length, 1);

      await publisher.publishProgress(turn, "Codex updated `README.md`.");
      await publisher.publishCompleted(turn, {
        text: "Finished.",
        truncated: false
      });
    }
  });

  await adapter.handleTurn({
    workspaceId: "feishu:workspace",
    channelId: "chat-1",
    scope: "thread",
    userId: "ou-user-1",
    text: "inspect the repo",
    acknowledge: async () => {
      acknowledged += 1;
    },
    postMessage: async (message) => {
      postedMessages.push(message);
      return {
        messageId: "om-working-1"
      };
    },
    updateMessage: async (messageId, message) => {
      updatedMessages.push({
        messageId,
        message
      });
    }
  });

  assert.match(
    JSON.parse(postedMessages[0].content).text,
    /\[Working\]\nStill working\. Last update: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/
  );
  assert.deepEqual(
    postedMessages.slice(1).map((message) => JSON.parse(message.content).text),
    ["Finished."]
  );
  assert.equal(updatedMessages.length, 2);
  assert.equal(updatedMessages[0].messageId, "om-working-1");
  assert.match(
    JSON.parse(updatedMessages[0].message.content).text,
    /\[Working\]\nStill working\. Last update: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/
  );
  assert.equal(updatedMessages[1].messageId, "om-working-1");
  assert.equal(
    JSON.parse(updatedMessages[1].message.content).text,
    "Codex updated `README.md`."
  );
});
