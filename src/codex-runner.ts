import { spawn, type ChildProcess } from "node:child_process";
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
  searchEnabled?: boolean;
  networkAccessEnabled?: boolean;
  addDirs?: string[];
  configOverrides?: string[];
  onEvent?: (event: CodexEvent) => void;
  signal?: AbortSignal;
}

const INTERRUPT_ESCALATE_TO_SIGTERM_MS = 5_000;
const INTERRUPT_ESCALATE_TO_SIGKILL_MS = 10_000;

export class CodexTurnInterruptedError extends Error {
  constructor(
    message: string | undefined = "Interrupted the active Codex turn.",
    readonly sessionId?: string
  ) {
    super(message ?? "Interrupted the active Codex turn.");
    this.name = "CodexTurnInterruptedError";
  }
}

export class CodexRunner {
  constructor(private readonly codexBinary: string = "codex") {}

  async runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    if (request.signal?.aborted) {
      throw new CodexTurnInterruptedError(undefined, request.sessionId);
    }

    const args = request.sessionId
      ? buildResumeArgs(request)
      : buildNewSessionArgs(request);

    const child = spawn(this.codexBinary, args, {
      cwd: request.repositoryPath,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let interruptRequested = false;
    const cleanupInterrupt = installInterruptHandler(child, request.signal, () => {
      interruptRequested = true;
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

    let exitCode = 1;
    let exitSignal: NodeJS.Signals | null = null;

    try {
      ({ exitCode, exitSignal } = await new Promise<{
        exitCode: number;
        exitSignal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) =>
          resolve({
            exitCode: code ?? 1,
            exitSignal: signal
          })
        );
      }));

      await Promise.all([stdoutTask, stderrTask]);
    } finally {
      cleanupInterrupt();
    }

    if (interruptRequested && (exitSignal || exitCode !== 0)) {
      throw new CodexTurnInterruptedError(undefined, sessionId);
    }

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
  const args = buildCommandPrefix(request);
  args.push("exec", "--json", "--skip-git-repo-check", "-C", request.repositoryPath);

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

  const args = buildCommandPrefix(request);
  args.push("exec", "resume", "--json", "--skip-git-repo-check");

  if (request.model) {
    args.push("-m", request.model);
  }

  appendConfigArgs(args, request);
  args.push(request.sessionId, request.prompt);
  return args;
}

function buildCommandPrefix(request: CodexTurnRequest): string[] {
  const args: string[] = [];

  if (request.searchEnabled) {
    // `--search` is a top-level Codex flag and must appear before `exec`.
    args.push("--search");
  }

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

  if (request.networkAccessEnabled && request.sandboxMode === "workspace-write") {
    overrides.push("sandbox_workspace_write.network_access=true");
  }

  return overrides;
}

function appendAddDirArgs(args: string[], addDirs: string[] | undefined): void {
  for (const addDir of addDirs ?? []) {
    args.push("--add-dir", addDir);
  }
}

function installInterruptHandler(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  onInterruptRequested: () => void
): () => void {
  if (!signal) {
    return () => undefined;
  }

  let sigtermTimer: NodeJS.Timeout | undefined;
  let sigkillTimer: NodeJS.Timeout | undefined;

  const requestInterrupt = () => {
    onInterruptRequested();

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill("SIGINT");

    sigtermTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }, INTERRUPT_ESCALATE_TO_SIGTERM_MS);

    sigkillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, INTERRUPT_ESCALATE_TO_SIGKILL_MS);
  };

  if (signal.aborted) {
    requestInterrupt();
  } else {
    signal.addEventListener("abort", requestInterrupt, { once: true });
  }

  return () => {
    signal.removeEventListener("abort", requestInterrupt);
    if (sigtermTimer) {
      clearTimeout(sigtermTimer);
    }
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
    }
  };
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
