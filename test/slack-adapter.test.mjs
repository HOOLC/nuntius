import assert from "node:assert/strict";
import test from "node:test";

import { SlackAdapter } from "../dist/adapters/slack.js";

test("Slack latest progress mode keeps tool counts and latest status in separate messages", async () => {
  const postedMessages = [];
  const updatedMessages = [];
  let acknowledged = 0;

  const adapter = new SlackAdapter({
    async handleTurn(turn, publisher) {
      assert.equal(acknowledged, 1);

      await publisher.publishProgress(turn, "Reading files.");
      await publisher.publishProgress(turn, "Editing README.md\n\n⚙️ 1 cmd");
      await publisher.publishCompleted(turn, {
        text: "Finished.\n\n⚙️ 1 cmd",
        truncated: false
      });
    }
  });

  await adapter.handleTurn({
    workspaceId: "slack:workspace",
    channelId: "thread-1",
    scope: "thread",
    userId: "user-1",
    text: "inspect the repo",
    progressMode: "latest",
    acknowledge: async () => {
      acknowledged += 1;
    },
    postMessage: async (message) => {
      postedMessages.push(message);
      return {
        messageTs: `slack-progress-${postedMessages.length}`
      };
    },
    updateMessage: async (messageTs, message) => {
      updatedMessages.push({
        messageTs,
        message
      });
    }
  });

  assert.deepEqual(postedMessages, ["🧰 0 tool updates", "Reading files."]);
  assert.deepEqual(updatedMessages, [
    {
      messageTs: "slack-progress-1",
      message: "⚙️ 1 cmd"
    },
    {
      messageTs: "slack-progress-2",
      message: "Editing README.md"
    },
    {
      messageTs: "slack-progress-1",
      message: "⚙️ 1 cmd"
    },
    {
      messageTs: "slack-progress-2",
      message: "Finished."
    }
  ]);
});
