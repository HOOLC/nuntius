import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";

import type { SessionReconciliationResult } from "./service.js";

export interface PackageScriptResult {
  ok: boolean;
  output: string;
}

export interface RunPackageScriptOptions {
  cwd: string;
  scriptName: string;
  maxOutputLines: number;
  maxOutputChars: number;
}

type SessionReconciliationLike = Pick<
  SessionReconciliationResult,
  | "totalBindings"
  | "updatedBindings"
  | "clearedHandlerSessions"
  | "clearedWorkerSessions"
  | "droppedRepositoryBindings"
>;

export function formatBridgeFailure(serviceLabel: string, error: unknown): string {
  if (error instanceof Error) {
    return `${serviceLabel} bridge failure: ${error.message}`;
  }

  return `${serviceLabel} bridge failure: unknown error.`;
}

export function logSessionReconciliation(
  context: string,
  result: SessionReconciliationLike
): void {
  console.log(
    `${context}: reconciled ${result.updatedBindings}/${result.totalBindings} persisted session bindings (cleared handler sessions=${result.clearedHandlerSessions}, cleared worker sessions=${result.clearedWorkerSessions}, dropped repository bindings=${result.droppedRepositoryBindings}).`
  );
}

export function formatSessionReconciliationLines(
  result: SessionReconciliationLike
): string[] {
  return [
    `- Session bindings refreshed: ${result.updatedBindings}/${result.totalBindings}`,
    `- Cleared handler sessions: ${result.clearedHandlerSessions}`,
    `- Cleared worker sessions: ${result.clearedWorkerSessions}`,
    `- Dropped repo bindings: ${result.droppedRepositoryBindings}`
  ];
}

export async function runPackageScript(
  options: RunPackageScriptOptions
): Promise<PackageScriptResult> {
  const child = spawn(getNpmCommand(), ["run", options.scriptName], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const lines: string[] = [];
  const appendLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    lines.push(line);
    if (lines.length > options.maxOutputLines) {
      lines.splice(0, lines.length - options.maxOutputLines);
    }
  };

  const stdoutReader = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  const stdoutTask = (async () => {
    for await (const line of stdoutReader) {
      appendLine(line);
    }
  })();

  const stderrReader = readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity
  });

  const stderrTask = (async () => {
    for await (const line of stderrReader) {
      appendLine(line);
    }
  })();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  await Promise.all([stdoutTask, stderrTask]);

  return {
    ok: exitCode === 0,
    output: clipScriptOutput(lines.join("\n"), options.maxOutputChars)
  };
}

function getNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function clipScriptOutput(output: string, maxOutputChars: number): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxOutputChars) {
    return trimmed;
  }

  return `${trimmed.slice(trimmed.length - maxOutputChars)}\n[truncated]`;
}
