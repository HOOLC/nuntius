import assert from "node:assert/strict";
import test from "node:test";

import { DiscordAdapter } from "../dist/adapters/discord.js";

test("Discord heartbeats use typing instead of a progress message", async () => {
  const messages = [];
  const reactions = [];
  let deferReplyCount = 0;
  let startTypingCount = 0;
  let stopTypingCount = 0;

  const adapter = new DiscordAdapter({
    async handleTurn(turn, publisher) {
      assert.equal(deferReplyCount, 1);
      assert.equal(startTypingCount, 0);

      await publisher.publishQueued(turn);
      await publisher.showWorkingIndicator?.(turn);
      assert.equal(startTypingCount, 1);

      await publisher.hideWorkingIndicator?.(turn);
      assert.equal(stopTypingCount, 1);

      await publisher.publishStarted(turn, {
        key: {
          platform: "discord",
          workspaceId: turn.workspaceId,
          channelId: turn.channelId,
          threadId: turn.threadId
        },
        activeRepository: {
          repositoryId: "repo",
          repositoryPath: "/repo",
          sandboxMode: "workspace-write",
          updatedAt: "2026-03-16T00:00:00.000Z"
        },
        createdByUserId: turn.userId,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z"
      });
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
    },
    syncStatusReaction: async (status) => {
      reactions.push(status);
    }
  });

  assert.deepEqual(messages, [
    "**Queued**\n> Waiting for the active Codex turn in this conversation.",
    "Codex updated `README.md`.",
    "Finished."
  ]);
  assert.deepEqual(reactions, ["queued", "working", "finished"]);
});

test("Discord adapter localizes queued and truncated system messages in Chinese", async () => {
  const messages = [];

  const adapter = new DiscordAdapter({
    async handleTurn(turn, publisher) {
      await publisher.publishQueued(turn, "zh");
      await publisher.publishCompleted(
        turn,
        {
          text: "已完成。",
          truncated: true
        },
        "zh"
      );
    }
  });

  await adapter.handleTurn({
    workspaceId: "discord:workspace",
    channelId: "thread-1",
    scope: "thread",
    userId: "user-1",
    text: "你好",
    deferReply: async () => undefined,
    followUp: async (message) => {
      messages.push(message);
    }
  });

  assert.deepEqual(messages, [
    "**已排队**\n> 当前会话已有进行中的 Codex turn，正在等待。",
    "已完成。\n\n_回复因 Discord 投递限制已被截断。_"
  ]);
});
