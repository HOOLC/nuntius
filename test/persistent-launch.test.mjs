import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  maybeRelaunchCurrentProcessPersistently,
  NUNTIUS_LAUNCH_MODE_ENV_KEY,
  NUNTIUS_PERSISTENT_LAUNCHED_ENV_KEY
} from "../dist/persistent-launch.js";

test("persistent launch relays the current process through systemd-run with guard env markers", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-persistent-launch-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const childScriptPath = path.join(root, "child.mjs");
  const fakeSystemdRunPath = path.join(root, "fake-systemd-run");
  const argLogPath = path.join(root, "systemd-run-args.txt");
  const childResultPath = path.join(root, "child-result.json");

  writeFileSync(
    childScriptPath,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(",
      "  process.env.RESULT_PATH,",
      "  JSON.stringify({",
      `    launchMode: process.env.${NUNTIUS_LAUNCH_MODE_ENV_KEY},`,
      `    launched: process.env.${NUNTIUS_PERSISTENT_LAUNCHED_ENV_KEY},`,
      "    marker: process.env.TEST_MARKER,",
      "    argv: process.argv.slice(2)",
      "  })",
      ");"
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    fakeSystemdRunPath,
    `#!/usr/bin/env bash
set -euo pipefail
: > "$ARG_LOG_PATH"
while (($#)); do
  printf '%s\\n' "$1" >> "$ARG_LOG_PATH"
  case "$1" in
    --setenv=*)
      export "\${1#--setenv=}"
      shift
      ;;
    --)
      shift
      for arg in "$@"; do
        printf '%s\\n' "$arg" >> "$ARG_LOG_PATH"
      done
      exec "$@"
      ;;
    *)
      shift
      ;;
  esac
done
`,
    {
      mode: 0o755
    }
  );
  chmodSync(fakeSystemdRunPath, 0o755);

  const originalConsoleLog = console.log;
  const consoleMessages = [];
  console.log = (...args) => {
    consoleMessages.push(args.join(" "));
  };

  try {
    const relaunched = await maybeRelaunchCurrentProcessPersistently({
      label: "Slack bot",
      env: {
        ...process.env,
        ARG_LOG_PATH: argLogPath,
        RESULT_PATH: childResultPath,
        TEST_MARKER: "persistent-ok",
        [NUNTIUS_LAUNCH_MODE_ENV_KEY]: "systemd-run"
      },
      argv: [childScriptPath, "hello"],
      cwd: root,
      systemdRunBinary: fakeSystemdRunPath
    });

    assert.equal(relaunched, true);
  } finally {
    console.log = originalConsoleLog;
  }

  const childResult = JSON.parse(readFileSync(childResultPath, "utf8"));
  assert.deepEqual(childResult, {
    launchMode: "direct",
    launched: "1",
    marker: "persistent-ok",
    argv: ["hello"]
  });

  const invocationArgs = readFileSync(argLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(invocationArgs.slice(0, 6), [
    "--user",
    "--collect",
    "--no-block",
    "--service-type=exec",
    "--working-directory",
    root
  ]);
  assert.equal(invocationArgs[6], "--unit");
  assert.match(invocationArgs[7], /^nuntius-slack-bot-\d+-\d+$/);
  assert.equal(invocationArgs[8], "--description=Slack bot");
  assert.ok(
    invocationArgs.includes(`--setenv=${NUNTIUS_LAUNCH_MODE_ENV_KEY}=direct`)
  );
  assert.ok(
    invocationArgs.includes(`--setenv=${NUNTIUS_PERSISTENT_LAUNCHED_ENV_KEY}=1`)
  );
  assert.ok(invocationArgs.includes("--setenv=TEST_MARKER=persistent-ok"));
  const commandStart = invocationArgs.lastIndexOf("--");
  assert.notEqual(commandStart, -1);
  assert.deepEqual(invocationArgs.slice(commandStart), [
    "--",
    process.execPath,
    childScriptPath,
    "hello"
  ]);
  assert.ok(
    consoleMessages.some((message) =>
      message.includes("Launched Slack bot persistently via systemd-run unit")
    )
  );
});

test("persistent launch surfaces a clear error when systemd-run is blocked", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-persistent-launch-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const fakeSystemdRunPath = path.join(root, "fake-systemd-run");
  writeFileSync(
    fakeSystemdRunPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "systemd-run blocked by policy" >&2
exit 1
`,
    {
      mode: 0o755
    }
  );
  chmodSync(fakeSystemdRunPath, 0o755);

  await assert.rejects(
    maybeRelaunchCurrentProcessPersistently({
      label: "nuntius",
      env: {
        ...process.env,
        [NUNTIUS_LAUNCH_MODE_ENV_KEY]: "systemd-run"
      },
      argv: [path.join(root, "child.mjs")],
      cwd: root,
      systemdRunBinary: fakeSystemdRunPath
    }),
    (error) => {
      assert.match(error.message, /Failed to launch nuntius persistently via systemd-run/);
      assert.match(error.message, /Run nuntius from an external terminal or supervisor instead/);
      assert.match(error.message, /systemd-run blocked by policy/);
      return true;
    }
  );
});

test("persistent launch is skipped after the process has already been relaunched", async () => {
  const relaunched = await maybeRelaunchCurrentProcessPersistently({
    label: "nuntius",
    env: {
      ...process.env,
      [NUNTIUS_LAUNCH_MODE_ENV_KEY]: "systemd-run",
      [NUNTIUS_PERSISTENT_LAUNCHED_ENV_KEY]: "1"
    },
    argv: [process.argv[1] ?? "test.mjs"]
  });

  assert.equal(relaunched, false);
});
