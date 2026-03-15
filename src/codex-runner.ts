import { spawn } from "node:child_process";
import readline from "node:readline";

import type {
  ApprovalPolicy,
  CodexEvent,
  CodexTurnResult,
  SandboxMode
} from "./domain.js";

export interface CodexTurnRequest {
  prompt: string;
  repositoryPath: string;
  sandboxMode: SandboxMode;
  sessionId?: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  addDirs?: string[];
  configOverrides?: string[];
  onEvent?: (event: CodexEvent) => void;
}

export class CodexRunner {
  constructor(private readonly codexBinary: string = "codex") {}

  async runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    const args = request.sessionId
      ? buildResumeArgs(request)
      : buildNewSessionArgs(request);

    const child = spawn(this.codexBinary, args, {
      cwd: request.repositoryPath,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let sessionId = request.sessionId;
    let responseText = "";
    const rawEvents: CodexEvent[] = [];
    const stderrLines: string[] = [];

    const stdoutReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });

    const stdoutTask = (async () => {
      for await (const line of stdoutReader) {
        if (!line.trim()) {
          continue;
        }

        const event = parseEvent(line);
        if (!event) {
          continue;
        }

        rawEvents.push(event);
        emitEvent(request.onEvent, event);

        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          sessionId = event.thread_id;
        }

        const agentText = extractAgentText(event);
        if (agentText) {
          responseText = agentText;
        }
      }
    })();

    const stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity
    });

    const stderrTask = (async () => {
      for await (const line of stderrReader) {
        if (line.trim()) {
          stderrLines.push(line);
        }
      }
    })();

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    await Promise.all([stdoutTask, stderrTask]);

    if (exitCode !== 0) {
      const details = stderrLines.length > 0 ? stderrLines.join("\n") : "No stderr output.";
      throw new Error(`Codex exited with code ${exitCode}.\n${details}`);
    }

    return {
      sessionId,
      responseText,
      rawEvents,
      stderrLines
    };
  }
}

function buildNewSessionArgs(request: CodexTurnRequest): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", request.repositoryPath];

  if (request.model) {
    args.push("-m", request.model);
  }

  appendConfigArgs(args, request);
  appendAddDirArgs(args, request.addDirs);
  args.push("-s", request.sandboxMode, request.prompt);
  return args;
}

function buildResumeArgs(request: CodexTurnRequest): string[] {
  if (!request.sessionId) {
    throw new Error("sessionId is required when resuming a Codex turn.");
  }

  const args = ["exec", "resume", "--json", "--skip-git-repo-check"];

  if (request.model) {
    args.push("-m", request.model);
  }

  appendConfigArgs(args, request);
  args.push(request.sessionId, request.prompt);
  return args;
}

function appendConfigArgs(args: string[], request: CodexTurnRequest): void {
  for (const override of buildConfigOverrides(request)) {
    args.push("-c", override);
  }
}

function buildConfigOverrides(request: CodexTurnRequest): string[] {
  const overrides = [...(request.configOverrides ?? [])];

  if (request.approvalPolicy) {
    overrides.push(`approval_policy="${request.approvalPolicy}"`);
  }

  return overrides;
}

function appendAddDirArgs(args: string[], addDirs: string[] | undefined): void {
  for (const addDir of addDirs ?? []) {
    args.push("--add-dir", addDir);
  }
}

function parseEvent(line: string): CodexEvent | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      return parsed as CodexEvent;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractAgentText(event: CodexEvent): string | undefined {
  if (event.type !== "item.completed") {
    return undefined;
  }

  const item = event.item;
  if (typeof item !== "object" || item === null) {
    return undefined;
  }

  if (!("type" in item) || item.type !== "agent_message") {
    return undefined;
  }

  if (!("text" in item) || typeof item.text !== "string") {
    return undefined;
  }

  return item.text;
}

function emitEvent(
  callback: ((event: CodexEvent) => void) | undefined,
  event: CodexEvent
): void {
  if (!callback) {
    return;
  }

  try {
    callback(event);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`Ignoring Codex event callback failure:\n${message}`);
  }
}
