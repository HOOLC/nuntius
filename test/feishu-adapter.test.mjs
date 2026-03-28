import assert from "node:assert/strict";
import test from "node:test";

import { FeishuAdapter } from "../dist/adapters/feishu.js";

test("Feishu reuses one progress message for heartbeats, progress updates, and the final reply", async () => {
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

      await publisher.publishProgress(turn, "1 command ran.");
      await publisher.publishProgress(turn, "1 command ran, 2 file changes.");
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
  assert.deepEqual(postedMessages.slice(1), []);
  assert.equal(updatedMessages.length, 4);
  assert.equal(updatedMessages[0].messageId, "om-working-1");
  assert.match(
    JSON.parse(updatedMessages[0].message.content).text,
    /\[Working\]\nStill working\. Last update: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/
  );
  assert.equal(updatedMessages[1].messageId, "om-working-1");
  assert.equal(
    JSON.parse(updatedMessages[1].message.content).text,
    "1 command ran."
  );
  assert.equal(updatedMessages[2].messageId, "om-working-1");
  assert.equal(
    JSON.parse(updatedMessages[2].message.content).text,
    "1 command ran, 2 file changes."
  );
  assert.equal(updatedMessages[3].messageId, "om-working-1");
  assert.equal(
    JSON.parse(updatedMessages[3].message.content).text,
    "Finished."
  );
});
