import assert from "node:assert/strict";
import test from "node:test";

import { FeishuAdapter } from "../dist/adapters/feishu.js";

test("Feishu heartbeats do not emit generic progress text and do not overwrite tool-call updates", async () => {
  const postedMessages = [];
  const updatedMessages = [];
  let acknowledged = 0;

  const adapter = new FeishuAdapter({
    async handleTurn(turn, publisher) {
      assert.equal(acknowledged, 1);

      await publisher.refreshWorkingIndicator?.(turn);
      assert.equal(postedMessages.length, 0);
      assert.equal(updatedMessages.length, 0);

      await publisher.publishProgress(turn, "1 command ran.");
      assert.equal(postedMessages.length, 1);
      assert.equal(updatedMessages.length, 0);

      await publisher.refreshWorkingIndicator?.(turn);
      assert.equal(postedMessages.length, 1);
      assert.equal(updatedMessages.length, 0);

      await publisher.publishProgress(turn, "1 command ran, 2 file changes.");
      assert.equal(updatedMessages.length, 1);

      await publisher.refreshWorkingIndicator?.(turn);
      assert.equal(postedMessages.length, 1);
      assert.equal(updatedMessages.length, 1);

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

  assert.equal(postedMessages.length, 2);
  assert.equal(JSON.parse(postedMessages[0].content).text, "1 command ran.");
  assert.equal(JSON.parse(postedMessages[1].content).text, "Finished.");
  assert.equal(updatedMessages.length, 1);
  assert.equal(updatedMessages[0].messageId, "om-working-1");
  assert.equal(
    JSON.parse(updatedMessages[0].message.content).text,
    "1 command ran, 2 file changes."
  );
});

test("Feishu rewrites markdown into plain-text-friendly output", async () => {
  const postedMessages = [];

  const adapter = new FeishuAdapter({
    async handleTurn(turn, publisher) {
      await publisher.publishCompleted(turn, {
        text: [
          "## Summary",
          "",
          "Touched [src/adapters/feishu.ts](/home/nomofu/nuntius/src/adapters/feishu.ts#L42).",
          "See [design doc](https://example.com/design).",
          "",
          "| File | Status |",
          "| --- | --- |",
          "| README.md | updated |",
          "| docs/feishu-setup.md | added |",
          "",
          "**Next**:",
          "* keep this short",
          "",
          "```md",
          "| leave | as-is |",
          "```"
        ].join("\n"),
        truncated: false
      });
    }
  });

  await adapter.handleTurn({
    workspaceId: "feishu:workspace",
    channelId: "chat-1",
    scope: "thread",
    userId: "ou-user-1",
    text: "format this",
    acknowledge: async () => undefined,
    postMessage: async (message) => {
      postedMessages.push(message);
      return {};
    }
  });

  assert.equal(postedMessages.length, 1);
  assert.equal(
    JSON.parse(postedMessages[0].content).text,
    [
      "Summary",
      "",
      "Touched src/adapters/feishu.ts:42.",
      "See design doc: https://example.com/design.",
      "",
      "- File: README.md; Status: updated",
      "- File: docs/feishu-setup.md; Status: added",
      "",
      "Next:",
      "- keep this short",
      "",
      "```md",
      "| leave | as-is |",
      "```"
    ].join("\n")
  );
});

test("Feishu latest progress mode keeps tool counts and latest status in separate messages", async () => {
  const postedMessages = [];
  const updatedMessages = [];

  const adapter = new FeishuAdapter({
    async handleTurn(turn, publisher) {
      await publisher.publishProgress(turn, "Reading files.");
      await publisher.publishProgress(turn, "Editing README.md\n\n⚙️ 1 cmd");
      await publisher.publishCompleted(turn, {
        text: "Finished.\n\n⚙️ 1 cmd",
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
    progressMode: "latest",
    acknowledge: async () => undefined,
    postMessage: async (message) => {
      postedMessages.push(message);
      return {
        messageId: `om-working-${postedMessages.length}`
      };
    },
    updateMessage: async (messageId, message) => {
      updatedMessages.push({
        messageId,
        message
      });
    }
  });

  assert.deepEqual(
    postedMessages.map((entry, index) => ({
      messageId: `om-working-${index + 1}`,
      text: JSON.parse(entry.content).text
    })),
    [
      {
        messageId: "om-working-1",
        text: "🧰 0 tool updates"
      },
      {
        messageId: "om-working-2",
        text: "Reading files."
      }
    ]
  );
  assert.deepEqual(
    updatedMessages.map((entry) => ({
      messageId: entry.messageId,
      text: JSON.parse(entry.message.content).text
    })),
    [
      {
        messageId: "om-working-1",
        text: "⚙️ 1 cmd"
      },
      {
        messageId: "om-working-2",
        text: "Editing README.md"
      },
      {
        messageId: "om-working-1",
        text: "⚙️ 1 cmd"
      },
      {
        messageId: "om-working-2",
        text: "Finished."
      }
    ]
  );
});
