import assert from "node:assert/strict";
import test from "node:test";

import { DiscordAdapter } from "../dist/adapters/discord.js";

test("Discord heartbeats use typing instead of a progress message", async () => {
  const messages = [];
  const progressMessages = [];
  const progressEdits = [];
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
      await publisher.publishProgress(turn, "1 command ran.");
      await publisher.publishProgress(turn, "1 command ran, 2 file changes.");
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
    postProgressMessage: async (message) => {
      progressMessages.push(message);
      return {
        async edit(content) {
          progressEdits.push(content);
        }
      };
    },
    syncStatusReaction: async (status) => {
      reactions.push(status);
    }
  });

  assert.deepEqual(messages, [
    "**Queued**\n> Waiting for the active Codex turn in this conversation.",
    "Finished."
  ]);
  assert.deepEqual(progressMessages, ["1 command ran."]);
  assert.deepEqual(progressEdits, ["1 command ran, 2 file changes."]);
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

test("Discord adapter rewrites markdown links into readable text", async () => {
  const messages = [];

  const adapter = new DiscordAdapter({
    async handleTurn(turn, publisher) {
      await publisher.publishProgress(
        turn,
        [
          "Touched [src/adapters/discord.ts](/home/nomofu/nuntius/src/adapters/discord.ts#L19).",
          "See [design doc](https://example.com/design).",
          "```md",
          "[leave-this](https://example.com/code)",
          "```"
        ].join("\n")
      );
    }
  });

  await adapter.handleTurn({
    workspaceId: "discord:workspace",
    channelId: "thread-1",
    scope: "thread",
    userId: "user-1",
    text: "format this",
    deferReply: async () => undefined,
    followUp: async (message) => {
      messages.push(message);
    }
  });

  assert.deepEqual(messages, [
    [
      "Touched src/adapters/discord.ts:19.",
      "See design doc <https://example.com/design>.",
      "```md",
      "[leave-this](https://example.com/code)",
      "```"
    ].join("\n")
  ]);
});

test("Discord latest progress mode keeps tool counts and latest status in separate editable messages", async () => {
  const messages = [];
  const progressMessages = [];
  const progressEdits = [];

  const adapter = new DiscordAdapter({
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
    workspaceId: "discord:workspace",
    channelId: "thread-1",
    scope: "thread",
    userId: "user-1",
    text: "inspect the repo",
    progressMode: "latest",
    deferReply: async () => undefined,
    followUp: async (message) => {
      messages.push(message);
    },
    postProgressMessage: async (message) => {
      const messageId = `progress-${progressMessages.length + 1}`;
      progressMessages.push({
        messageId,
        message
      });
      return {
        async edit(content) {
          progressEdits.push({
            messageId,
            message: content
          });
        }
      };
    }
  });

  assert.deepEqual(messages, []);
  assert.deepEqual(progressMessages, [
    {
      messageId: "progress-1",
      message: "🧰 0 tool updates"
    },
    {
      messageId: "progress-2",
      message: "Reading files."
    }
  ]);
  assert.deepEqual(progressEdits, [
    {
      messageId: "progress-1",
      message: "⚙️ 1 cmd"
    },
    {
      messageId: "progress-2",
      message: "Editing README.md"
    },
    {
      messageId: "progress-1",
      message: "⚙️ 1 cmd"
    },
    {
      messageId: "progress-2",
      message: "Finished."
    }
  ]);
});
