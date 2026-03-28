import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCORD_MESSAGE_LIMIT,
  sendDiscordEditableText,
  sendDiscordInteractionResponse,
  splitDiscordMessage
} from "../dist/discord-delivery.js";

test("splitDiscordMessage prefers natural boundaries for long prose", () => {
  const content = buildLongProse();
  const chunks = splitDiscordMessage(content);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT));
  assert.equal(chunks.join(""), content);

  for (let index = 0; index < chunks.length - 1; index += 1) {
    assert.match(chunks[index], /[^A-Za-z0-9]$/);
    assert.match(chunks[index + 1], /^\S/);
  }
});

test("splitDiscordMessage closes and reopens code fences without exceeding the Discord limit", () => {
  const codeLine = `const payload = ${JSON.stringify("x".repeat(140))};`;
  const content = [
    "Generated file preview:",
    "```ts",
    Array.from({ length: 24 }, () => codeLine).join("\n"),
    "```"
  ].join("\n");

  const chunks = splitDiscordMessage(content);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT));
  assert.ok(chunks.every((chunk) => ((chunk.match(/```/g) ?? []).length % 2) === 0));
  assert.ok(chunks[0].includes("```ts"));
  assert.ok(chunks.at(-1)?.endsWith("```"));
});

test("sendDiscordInteractionResponse edits the deferred reply first, then uses follow-ups", async () => {
  const content = buildLongProse();
  const chunks = splitDiscordMessage(content);
  const calls = [];
  const state = {
    initialResponseSent: false
  };
  const interaction = createInteractionRecorder(calls, {
    deferred: true,
    replied: false
  });

  await sendDiscordInteractionResponse(interaction, content, state);

  assert.equal(state.initialResponseSent, true);
  assert.deepEqual(calls[0], {
    method: "editReply",
    content: chunks[0]
  });
  assert.deepEqual(
    calls.slice(1),
    chunks.slice(1).map((chunk) => ({
      method: "followUp",
      content: chunk,
      ephemeral: true
    }))
  );

  calls.length = 0;
  await sendDiscordInteractionResponse(interaction, "Final status.", state);
  assert.deepEqual(calls, [
    {
      method: "followUp",
      content: "Final status.",
      ephemeral: true
    }
  ]);
});

test("sendDiscordInteractionResponse replies ephemerally before using follow-ups", async () => {
  const content = buildLongProse();
  const chunks = splitDiscordMessage(content);
  const calls = [];
  const interaction = createInteractionRecorder(calls, {
    deferred: false,
    replied: false
  });

  await sendDiscordInteractionResponse(interaction, content);

  assert.deepEqual(calls[0], {
    method: "reply",
    content: chunks[0],
    ephemeral: true
  });
  assert.deepEqual(
    calls.slice(1),
    chunks.slice(1).map((chunk) => ({
      method: "followUp",
      content: chunk,
      ephemeral: true
    }))
  );
});

test("sendDiscordEditableText only returns an editable handle for single-chunk content", async () => {
  const shortSends = [];
  const longSends = [];
  const editableMessage = {
    async edit() {
      return undefined;
    }
  };

  const shortHandle = await sendDiscordEditableText(
    {
      async send(content) {
        shortSends.push(content);
        return editableMessage;
      }
    },
    "1 command ran."
  );
  const longContent = buildLongProse();
  const longHandle = await sendDiscordEditableText(
    {
      async send(content) {
        longSends.push(content);
        return editableMessage;
      }
    },
    longContent
  );

  assert.equal(shortHandle, editableMessage);
  assert.deepEqual(shortSends, ["1 command ran."]);
  assert.equal(longHandle, undefined);
  assert.deepEqual(longSends, splitDiscordMessage(longContent));
});

function buildLongProse() {
  return Array.from(
    { length: 180 },
    (_, index) => `Sentence ${index} keeps this Discord reply readable when it has to be split. `
  ).join("").trim();
}

function createInteractionRecorder(calls, options) {
  return {
    deferred: options.deferred,
    replied: options.replied,
    async reply({ content, ephemeral }) {
      calls.push({
        method: "reply",
        content,
        ephemeral
      });
    },
    async editReply({ content }) {
      calls.push({
        method: "editReply",
        content
      });
    },
    async followUp({ content, ephemeral }) {
      calls.push({
        method: "followUp",
        content,
        ephemeral
      });
    }
  };
}
