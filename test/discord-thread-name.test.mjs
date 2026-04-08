import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscordThreadName,
  generateDiscordThreadNameSuffix
} from "../dist/discord-thread-name.js";

test("discord thread names append a readable word suffix", () => {
  assert.equal(
    buildDiscordThreadName("codex", "nuntius", "silver-otter"),
    "codex-nuntius-silver-otter"
  );
});

test("discord thread names fall back to session when the seed normalizes to empty", () => {
  assert.equal(
    buildDiscordThreadName("codex", "!!!", "silver-otter"),
    "codex-session-silver-otter"
  );
});

test("discord thread name suffixes are generated as readable word slugs", () => {
  const suffix = generateDiscordThreadNameSuffix();

  assert.match(suffix, /^[a-z]+-[a-z]+$/);
});

test("discord thread names keep the word suffix within Discord's length limit", () => {
  const name = buildDiscordThreadName("codex", "A".repeat(200), "silver-otter");

  assert.ok(name.length <= 100);
  assert.match(name, /^codex-[a-z0-9-]+-silver-otter$/);
  assert.ok(name.endsWith("-silver-otter"));
});
