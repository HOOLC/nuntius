import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexRunner, CodexTurnInterruptedError } from "../dist/codex-runner.js";

test("CodexRunner interrupts the active Codex process and preserves the session id", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-runner-interrupt-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repoDir = path.join(root, "repo");
  const fakeCodexPath = path.join(root, "fake-codex");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(fakeCodexPath, buildInterruptibleCodexScript(), {
    mode: 0o755
  });
  chmodSync(fakeCodexPath, 0o755);

  const runner = new CodexRunner(fakeCodexPath);
  const controller = new AbortController();
  const turn = runner.runTurn({
    prompt: "wait for an interrupt",
    repositoryPath: repoDir,
    sandboxMode: "workspace-write",
    signal: controller.signal
  });

  await delay(100);
  controller.abort();

  await assert.rejects(turn, (error) => {
    assert.ok(error instanceof CodexTurnInterruptedError);
    assert.equal(error.sessionId, "worker-session");
    assert.equal(error.message, "Interrupted the active Codex turn.");
    return true;
  });
});

function buildInterruptibleCodexScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"type":"thread.started","thread_id":"worker-session"}'
trap 'exit 130' INT
while true; do
  sleep 1
done
`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
