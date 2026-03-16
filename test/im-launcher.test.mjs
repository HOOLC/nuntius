import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { detectConfiguredIntegrations } from "../dist/index.js";

test("detectConfiguredIntegrations enables integrations declared in nuntius.toml", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-launcher-config-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const configPath = path.join(root, "nuntius.toml");
  writeFileSync(
    configPath,
    [
      "[bridge]",
      'default_repository_id = "default"',
      "",
      "[discord]",
      'token = "discord-token"',
      "",
      "[feishu]",
      'app_id = "cli-test"',
      'app_secret = "secret-test"'
    ].join("\n")
  );

  const previousConfigPath = process.env.NUNTIUS_CONFIG_PATH;
  process.env.NUNTIUS_CONFIG_PATH = configPath;

  t.after(() => {
    if (previousConfigPath === undefined) {
      delete process.env.NUNTIUS_CONFIG_PATH;
    } else {
      process.env.NUNTIUS_CONFIG_PATH = previousConfigPath;
    }
  });

  const selection = detectConfiguredIntegrations({});
  assert.deepEqual(selection.enabled, ["discord", "feishu"]);
  assert.deepEqual(selection.skipped, ["slack"]);
});

test("detectConfiguredIntegrations falls back to environment variables when no config file is present", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-launcher-env-"));
  const previousConfigPath = process.env.NUNTIUS_CONFIG_PATH;
  const configPath = path.join(root, "nuntius.toml");
  writeFileSync(configPath, "");
  process.env.NUNTIUS_CONFIG_PATH = configPath;

  try {
    const selection = detectConfiguredIntegrations({
      NUNTIUS_SLACK_BOT_TOKEN: "xoxb-test"
    });
    assert.deepEqual(selection.enabled, ["slack"]);
    assert.deepEqual(selection.skipped, ["discord", "feishu"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousConfigPath === undefined) {
      delete process.env.NUNTIUS_CONFIG_PATH;
    } else {
      process.env.NUNTIUS_CONFIG_PATH = previousConfigPath;
    }
  }
});
