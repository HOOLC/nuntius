import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROCESS_GUARD_RUNNER_PATH = path.join(TEST_DIR, "fixtures", "process-guard-runner.mjs");
const PROCESS_GUARD_CHILD_PATH = path.join(TEST_DIR, "fixtures", "process-guard-child.mjs");

test("process guard restarts a child that exits with the restart code", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-process-guard-"));
  const counterPath = path.join(root, "counter.txt");
  writeFileSync(counterPath, "0");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGuardFixture({
    NUNTIUS_TEST_CHILD_MODULE_PATH: PROCESS_GUARD_CHILD_PATH,
    NUNTIUS_TEST_COUNTER_PATH: counterPath,
    NUNTIUS_TEST_RESTARTS: "1",
    NUNTIUS_TEST_FINAL_EXIT_CODE: "0"
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(readFileSync(counterPath, "utf8"), "2");
});

test("process guard surfaces unexpected child exits", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-process-guard-"));
  const counterPath = path.join(root, "counter.txt");
  writeFileSync(counterPath, "0");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGuardFixture({
    NUNTIUS_TEST_CHILD_MODULE_PATH: PROCESS_GUARD_CHILD_PATH,
    NUNTIUS_TEST_COUNTER_PATH: counterPath,
    NUNTIUS_TEST_RESTARTS: "0",
    NUNTIUS_TEST_FINAL_EXIT_CODE: "23"
  });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(readFileSync(counterPath, "utf8"), "1");
});

async function runGuardFixture(env) {
  const child = spawn(process.execPath, [PROCESS_GUARD_RUNNER_PATH], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for process guard fixture.\nstdout:\n${stdout || "<empty>"}\nstderr:\n${stderr || "<empty>"}`
        )
      );
    }, 5_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, stdout });
    });
  });
}
