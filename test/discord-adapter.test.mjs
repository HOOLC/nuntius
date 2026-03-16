import assert from "node:assert/strict";
import test from "node:test";

import { DiscordAdapter } from "../dist/adapters/discord.js";

test("Discord heartbeats use typing instead of a progress message", async () => {
  const messages = [];
  let deferReplyCount = 0;
  let startTypingCount = 0;
  let stopTypingCount = 0;

  const adapter = new DiscordAdapter({
    async handleTurn(turn, publisher) {
      assert.equal(deferReplyCount, 1);
      assert.equal(startTypingCount, 0);

      await publisher.showWorkingIndicator?.(turn);
      assert.equal(startTypingCount, 1);

      await publisher.hideWorkingIndicator?.(turn);
      assert.equal(stopTypingCount, 1);

      await publisher.publishProgress(turn, "Codex updated `README.md`.");
      await publisher.publishCompleted(turn, {
        text: "Finished.",
        truncated: false
      });
    }
  });

  await adapter.handleTurn({
    workspaceId: "discord:workspace",
    channelId: "thread-1",
    scope: "thread",
    userId: "user-1",
    text: "inspect the repo",
    deferReply: async () => {
      deferReplyCount += 1;
    },
    startTyping: async () => {
      startTypingCount += 1;
      return {
        async stop() {
          stopTypingCount += 1;
        }
      };
    },
    followUp: async (message) => {
      messages.push(message);
    }
  });

  assert.deepEqual(messages, [
    "**Working**\n> Codex updated `README.md`.",
    "Finished."
  ]);
});
