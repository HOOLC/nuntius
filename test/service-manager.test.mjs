import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLogsCommand,
  installManagedService,
  restartManagedService,
  startManagedService,
  statusManagedService,
  stopManagedService,
  uninstallManagedService
} from "../dist/service-manager.js";

test("launchd service install writes a LaunchAgent and lifecycle commands target it", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-launchd-service-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const workingDirectory = path.join(root, "repo");
  mkdirSync(workingDirectory, { recursive: true });

  const commands = [];
  const runCommand = async (command, args, options = {}) => {
    commands.push({ command, args, allowFailure: Boolean(options.allowFailure) });
    return {
      code: 0,
      stdout: `${command} ${args.join(" ")}`,
      stderr: ""
    };
  };

  const options = {
    platform: "darwin",
    serviceName: "nuntius-test",
    integration: "feishu",
    homeDir: root,
    uid: 501,
    workingDirectory,
    nodePath: "/opt/node/bin/node",
    scriptPath: "/app/dist/feishu-bot.js",
    configPath: "/app/nuntius.toml",
    logDir: path.join(root, "logs"),
    runCommand
  };

  const definition = await installManagedService(options);
  assert.equal(definition.launchd.label, "com.hoolc.nuntius-test");
  assert.equal(definition.launchd.domain, "gui/501");
  assert.deepEqual(commands, []);

  const plist = readFileSync(definition.launchd.plistPath, "utf8");
  assert.match(plist, /<key>Label<\/key>\n  <string>com.hoolc.nuntius-test<\/string>/);
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/app\/dist\/feishu-bot.js<\/string>/);
  assert.match(plist, /<key>NUNTIUS_CONFIG_PATH<\/key>\n    <string>\/app\/nuntius.toml<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);

  await startManagedService(options);
  assert.deepEqual(commands.splice(0), [
    {
      command: "launchctl",
      args: ["bootstrap", "gui/501", definition.launchd.plistPath],
      allowFailure: false
    },
    {
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/com.hoolc.nuntius-test"],
      allowFailure: false
    }
  ]);

  await restartManagedService(options);
  assert.deepEqual(commands.splice(0), [
    {
      command: "launchctl",
      args: ["bootout", "gui/501/com.hoolc.nuntius-test"],
      allowFailure: true
    },
    {
      command: "launchctl",
      args: ["bootstrap", "gui/501", definition.launchd.plistPath],
      allowFailure: false
    },
    {
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/com.hoolc.nuntius-test"],
      allowFailure: false
    }
  ]);

  const status = await statusManagedService(options);
  assert.equal(status.stdout, "launchctl print gui/501/com.hoolc.nuntius-test");
  assert.deepEqual(commands.splice(0), [
    {
      command: "launchctl",
      args: ["print", "gui/501/com.hoolc.nuntius-test"],
      allowFailure: true
    }
  ]);

  assert.deepEqual(buildLogsCommand(options), {
    command: "tail",
    args: [
      "-n",
      "200",
      definition.launchd.stdoutPath,
      definition.launchd.stderrPath
    ]
  });

  await uninstallManagedService(options);
  assert.deepEqual(commands.splice(0), [
    {
      command: "launchctl",
      args: ["bootout", "gui/501/com.hoolc.nuntius-test"],
      allowFailure: true
    }
  ]);
});

test("systemd service install writes a user unit and lifecycle commands target it", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nuntius-systemd-service-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const workingDirectory = path.join(root, "repo");
  mkdirSync(workingDirectory, { recursive: true });
  writeFileSync(path.join(workingDirectory, "nuntius.toml"), "[bridge]\n", "utf8");

  const commands = [];
  const runCommand = async (command, args, options = {}) => {
    commands.push({ command, args, allowFailure: Boolean(options.allowFailure) });
    return {
      code: 0,
      stdout: `${command} ${args.join(" ")}`,
      stderr: ""
    };
  };

  const options = {
    platform: "linux",
    serviceName: "nuntius-test",
    integration: "all",
    homeDir: root,
    workingDirectory,
    nodePath: "/usr/bin/node",
    scriptPath: "/srv/nuntius/dist/index.js",
    env: {
      EXTRA_MARKER: "ok"
    },
    runCommand
  };

  const definition = await installManagedService(options);
  assert.equal(definition.systemd.unitName, "nuntius-test.service");
  assert.deepEqual(commands.splice(0), [
    {
      command: "systemctl",
      args: ["--user", "daemon-reload"],
      allowFailure: false
    },
    {
      command: "systemctl",
      args: ["--user", "enable", "nuntius-test.service"],
      allowFailure: false
    }
  ]);

  const unit = readFileSync(definition.systemd.unitPath, "utf8");
  assert.match(unit, /Description=nuntius IM bridge/);
  assert.match(unit, /WorkingDirectory=.*repo"/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/srv\/nuntius\/dist\/index.js"/);
  assert.match(unit, /Environment="EXTRA_MARKER=ok"/);
  assert.match(unit, /Environment="NUNTIUS_CONFIG_PATH=.*nuntius.toml"/);
  assert.match(unit, /Restart=always/);

  await startManagedService(options);
  await stopManagedService(options);
  await restartManagedService(options);
  await statusManagedService(options);
  assert.deepEqual(commands.splice(0), [
    {
      command: "systemctl",
      args: ["--user", "start", "nuntius-test.service"],
      allowFailure: false
    },
    {
      command: "systemctl",
      args: ["--user", "stop", "nuntius-test.service"],
      allowFailure: true
    },
    {
      command: "systemctl",
      args: ["--user", "restart", "nuntius-test.service"],
      allowFailure: false
    },
    {
      command: "systemctl",
      args: ["--user", "status", "--no-pager", "nuntius-test.service"],
      allowFailure: true
    }
  ]);

  assert.deepEqual(buildLogsCommand({ ...options, follow: true, lines: 50 }), {
    command: "journalctl",
    args: ["--user", "-u", "nuntius-test.service", "-n", "50", "-f"]
  });

  await uninstallManagedService(options);
  assert.deepEqual(commands.splice(0), [
    {
      command: "systemctl",
      args: ["--user", "disable", "--now", "nuntius-test.service"],
      allowFailure: true
    },
    {
      command: "systemctl",
      args: ["--user", "daemon-reload"],
      allowFailure: false
    }
  ]);
});
