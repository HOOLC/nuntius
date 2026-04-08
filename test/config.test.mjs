import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../dist/config.js";

test("loadConfig defaults progress updates to minimal", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-config-progress-default-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repoDir = path.join(root, "repo");
  const configPath = path.join(root, "nuntius.toml");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    configPath,
    [
      "[bridge]",
      'default_repository_id = "repo"',
      `session_store_path = ${JSON.stringify(path.join(root, "sessions.json"))}`,
      "",
      "[[repository_targets]]",
      'id = "repo"',
      `path = ${JSON.stringify(repoDir)}`,
      'sandbox_mode = "workspace-write"'
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

  const config = loadConfig();
  assert.equal(config.progressUpdates, "minimal");
});

test("loadConfig accepts verbose progress updates", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-config-progress-verbose-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repoDir = path.join(root, "repo");
  const configPath = path.join(root, "nuntius.toml");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    configPath,
    [
      "[bridge]",
      'default_repository_id = "repo"',
      'progress_updates = "verbose"',
      `session_store_path = ${JSON.stringify(path.join(root, "sessions.json"))}`,
      "",
      "[[repository_targets]]",
      'id = "repo"',
      `path = ${JSON.stringify(repoDir)}`,
      'sandbox_mode = "workspace-write"'
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

  const config = loadConfig();
  assert.equal(config.progressUpdates, "verbose");
});

test("loadConfig accepts latest progress updates", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-config-progress-latest-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repoDir = path.join(root, "repo");
  const configPath = path.join(root, "nuntius.toml");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    configPath,
    [
      "[bridge]",
      'default_repository_id = "repo"',
      'progress_updates = "latest"',
      `session_store_path = ${JSON.stringify(path.join(root, "sessions.json"))}`,
      "",
      "[[repository_targets]]",
      'id = "repo"',
      `path = ${JSON.stringify(repoDir)}`,
      'sandbox_mode = "workspace-write"'
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

  const config = loadConfig();
  assert.equal(config.progressUpdates, "latest");
});
