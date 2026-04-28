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
const APP_SERVER_INITIALIZED_METHOD = "notifications/initialized";

interface JsonRpcSuccessResponse {
  id: number;
  result: unknown;
}

interface JsonRpcErrorResponse {
  id: number;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

type JsonRpcMessage =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification
  | JsonRpcRequest;

interface AppServerExitResult {
  exitCode: number;
  exitSignal: NodeJS.Signals | null;
}

interface TurnOutcome {
  status: "completed" | "failed" | "interrupted";
  message?: string;
}

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

    const child = spawn(this.codexBinary, buildAppServerArgs(request), {
      cwd: request.repositoryPath,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new CodexAppServerClient(child);

    let sessionId = request.sessionId;
    let turnId: string | undefined;
    let responseText = "";
    let interruptRequested = false;
    const rawEvents: CodexEvent[] = [];
    const stderrLines: string[] = [];
    const agentMessageBuffers = new Map<string, string>();
    let turnOutcome = createDeferred<TurnOutcome>();

    client.onStderrLine = (line) => {
      if (line.trim()) {
        stderrLines.push(line);
      }
    };

    client.onNotification = (message) => {
      if (message.method === "thread/started") {
        sessionId = extractThreadId(message.params) ?? sessionId;
      }

      if (message.method === "turn/started") {
        turnId = extractTurnId(message.params) ?? turnId;
      }

      if (message.method === "item/agentMessage/delta") {
        const itemId = readString(readRecord(message.params), "itemId");
        const delta = readString(readRecord(message.params), "delta");
        if (itemId && typeof delta === "string") {
          const next = `${agentMessageBuffers.get(itemId) ?? ""}${delta}`;
          agentMessageBuffers.set(itemId, next);
          responseText = next;
        }
      }

      if (message.method === "configWarning") {
        const params = readRecord(message.params);
        const summary = readString(params, "summary");
        const details = readString(params, "details");
        if (summary) {
          stderrLines.push(details ? `${summary}\n${details}` : summary);
        }
      }

      if (message.method === "error") {
        const errorInfo = readRecord(readRecord(message.params), "error");
        const messageText = buildTurnErrorMessage(errorInfo);
        if (messageText) {
          stderrLines.push(messageText);
        }
      }

      const event = normalizeNotification(message);
      if (event) {
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

      if (message.method === "turn/completed") {
        const params = readRecord(message.params);
        const turn = readRecord(params, "turn");
        const status = readString(turn, "status");
        const completedTurnId = readString(turn, "id");
        if (completedTurnId) {
          turnId = completedTurnId;
        }

        if (status === "completed") {
          turnOutcome.resolve({ status: "completed" });
          return;
        }

        if (status === "interrupted") {
          turnOutcome.resolve({ status: "interrupted" });
          return;
        }

        if (status === "failed") {
          turnOutcome.resolve({
            status: "failed",
            message: buildTurnErrorMessage(readRecord(turn, "error"))
          });
        }
      }
    };

    client.onRequest = async (message) => handleServerRequest(message, stderrLines);

    const interruptState = installInterruptHandler({
      child,
      signal: request.signal,
      getThreadId: () => sessionId,
      getTurnId: () => turnId,
      onInterruptRequested: () => {
        interruptRequested = true;
      },
      requestInterrupt: async (threadId, activeTurnId) => {
        await client.request("turn/interrupt", {
          threadId,
          turnId: activeTurnId
        });
      }
    });

    try {
      await client.request("initialize", {
        clientInfo: {
          name: "nuntius",
          version: process.env.npm_package_version ?? "dev"
        },
        capabilities: null
      });
      client.notify(APP_SERVER_INITIALIZED_METHOD);

      if (request.sessionId) {
        const response = await client.request("thread/resume", buildResumeParams(request));
        sessionId = extractThreadId(response) ?? sessionId;
      } else {
        const response = await client.request("thread/start", buildThreadStartParams(request));
        sessionId = extractThreadId(response) ?? sessionId;
      }

      if (!sessionId) {
        throw new Error("Codex app server did not return a thread id.");
      }

      const turnStartResponse = await client.request("turn/start", buildTurnStartParams(request, sessionId));
      turnId = extractTurnId(turnStartResponse) ?? turnId;
      void interruptState.requestPendingInterrupt();

      const exitResult = await Promise.race([
        turnOutcome.promise,
        client.waitForExit().then((result) => ({ status: "process_exit" as const, result }))
      ]);

      if ("result" in exitResult) {
        if (interruptRequested) {
          throw new CodexTurnInterruptedError(undefined, sessionId);
        }

        throw buildUnexpectedExitError(exitResult.result, stderrLines);
      }

      if (exitResult.status === "interrupted") {
        throw new CodexTurnInterruptedError(undefined, sessionId);
      }

      if (exitResult.status === "failed") {
        const details = exitResult.message ?? (stderrLines.join("\n") || "No stderr output.");
        throw new Error(details);
      }

      const shutdown = await client.shutdown();
      if (shutdown.exitCode !== 0 && shutdown.exitSignal === null) {
        throw buildUnexpectedExitError(shutdown, stderrLines);
      }

      return {
        sessionId,
        responseText,
        rawEvents,
        stderrLines
      };
    } finally {
      interruptState.cleanup();
      if (!client.isClosed()) {
        await client.shutdown();
      }
    }
  }
}

class CodexAppServerClient {
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly stdoutTask: Promise<void>;
  private readonly stderrTask: Promise<void>;
  private readonly exitPromise: Promise<AppServerExitResult>;
  private nextRequestId = 1;
  private closed = false;

  onNotification?: (message: JsonRpcNotification) => void;
  onRequest?: (message: JsonRpcRequest) => Promise<unknown> | unknown;
  onStderrLine?: (line: string) => void;

  constructor(private readonly child: ChildProcess) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Codex app server child process is missing stdio pipes.");
    }

    this.stdoutTask = this.readStdout();
    this.stderrTask = this.readStderr();
    this.exitPromise = new Promise<AppServerExitResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", async (code, signal) => {
        this.closed = true;
        const error = new Error("Codex app server exited before responding.");
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();

        try {
          await Promise.all([this.stdoutTask, this.stderrTask]);
        } catch {
          // Reader failures should not mask the process exit result.
        }

        resolve({
          exitCode: code ?? 1,
          exitSignal: signal
        });
      });
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("Codex app server is not available.");
    }

    const id = this.nextRequestId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return response;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      return;
    }

    const message =
      params === undefined
        ? {
            jsonrpc: "2.0",
            method
          }
        : {
            jsonrpc: "2.0",
            method,
            params
          };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitForExit(): Promise<AppServerExitResult> {
    return this.exitPromise;
  }

  async shutdown(): Promise<AppServerExitResult> {
    if (this.closed) {
      return this.exitPromise;
    }

    this.child.stdin?.end();

    const timeout = setTimeout(() => {
      if (!this.closed) {
        this.child.kill("SIGTERM");
      }
    }, 200);

    try {
      return await this.exitPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readStdout(): Promise<void> {
    const reader = readline.createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity
    });

    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const message = parseJsonRpcMessage(trimmed);
      if (!message) {
        continue;
      }

      if ("result" in message || "error" in message) {
        this.resolvePending(message);
        continue;
      }

      if ("id" in message) {
        await this.resolveServerRequest(message);
        continue;
      }

      try {
        this.onNotification?.(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`Ignoring Codex app server notification failure:\n${detail}`);
      }
    }
  }

  private async readStderr(): Promise<void> {
    const reader = readline.createInterface({
      input: this.child.stderr!,
      crlfDelay: Infinity
    });

    for await (const line of reader) {
      this.onStderrLine?.(line);
    }
  }

  private resolvePending(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if ("error" in message) {
      pending.reject(
        new Error(message.error.message ?? `Codex app server request ${message.id} failed.`)
      );
      return;
    }

    pending.resolve(message.result);
  }

  private async resolveServerRequest(message: JsonRpcRequest): Promise<void> {
    if (!this.child.stdin || this.child.stdin.destroyed) {
      return;
    }

    try {
      const result = await this.onRequest?.(message);
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: result ?? null
        })}\n`
      );
    } catch (error) {
      const payload =
        error instanceof AppServerRequestError
          ? {
              code: error.code,
              message: error.message
            }
          : {
              code: -32000,
              message: error instanceof Error ? error.message : String(error)
            };
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: payload
        })}\n`
      );
    }
  }
}

class AppServerRequestError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "AppServerRequestError";
  }
}

function buildAppServerArgs(request: CodexTurnRequest): string[] {
  const args = buildCommandPrefix(request);
  args.push("app-server");
  appendConfigArgs(args, request);
  return args;
}

function buildThreadStartParams(request: CodexTurnRequest): Record<string, unknown> {
  return {
    cwd: request.repositoryPath,
    approvalPolicy: request.approvalPolicy,
    sandbox: request.sandboxMode,
    model: request.model,
    experimentalRawEvents: false,
    persistExtendedHistory: false
  };
}

function buildResumeParams(request: CodexTurnRequest): Record<string, unknown> {
  if (!request.sessionId) {
    throw new Error("sessionId is required when resuming a Codex turn.");
  }

  return {
    threadId: request.sessionId,
    cwd: request.repositoryPath,
    approvalPolicy: request.approvalPolicy,
    sandbox: request.sandboxMode,
    model: request.model,
    persistExtendedHistory: false
  };
}

function buildTurnStartParams(
  request: CodexTurnRequest,
  sessionId: string
): Record<string, unknown> {
  return {
    threadId: sessionId,
    input: [
      {
        type: "text",
        text: request.prompt,
        text_elements: []
      }
    ],
    cwd: request.repositoryPath,
    approvalPolicy: request.approvalPolicy,
    model: request.model,
    sandboxPolicy: buildSandboxPolicy(request)
  };
}

function buildSandboxPolicy(request: CodexTurnRequest): Record<string, unknown> {
  switch (request.sandboxMode) {
    case "danger-full-access":
      return {
        type: "dangerFullAccess"
      };
    case "read-only":
      return {
        type: "readOnly",
        access: {
          type: "fullAccess"
        },
        networkAccess: Boolean(request.networkAccessEnabled)
      };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: uniquePaths([request.repositoryPath, ...(request.addDirs ?? [])]),
        readOnlyAccess: {
          type: "fullAccess"
        },
        networkAccess: Boolean(request.networkAccessEnabled),
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
    default:
      return {
        type: "dangerFullAccess"
      };
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function buildCommandPrefix(request: CodexTurnRequest): string[] {
  const args: string[] = [];

  if (isYoloTurn(request)) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (request.searchEnabled) {
    args.push("--search");
  }

  return args;
}

function isYoloTurn(request: CodexTurnRequest): boolean {
  return request.sandboxMode === "danger-full-access" && request.approvalPolicy === "never";
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

function installInterruptHandler(input: {
  child: ChildProcess;
  signal: AbortSignal | undefined;
  getThreadId: () => string | undefined;
  getTurnId: () => string | undefined;
  onInterruptRequested: () => void;
  requestInterrupt: (threadId: string, turnId: string) => Promise<void>;
}): {
  cleanup: () => void;
  requestPendingInterrupt: () => Promise<void>;
} {
  const { child, signal } = input;
  if (!signal) {
    return {
      cleanup: () => undefined,
      requestPendingInterrupt: async () => undefined
    };
  }

  let sigtermTimer: NodeJS.Timeout | undefined;
  let sigkillTimer: NodeJS.Timeout | undefined;
  let handled = false;
  let interruptRequestPromise: Promise<void> | undefined;

  const requestPendingInterrupt = async () => {
    if (!handled || interruptRequestPromise) {
      return interruptRequestPromise;
    }
    const threadId = input.getThreadId();
    const turnId = input.getTurnId();
    if (!threadId || !turnId) {
      return undefined;
    }

    interruptRequestPromise = input.requestInterrupt(threadId, turnId).catch(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    });
    return interruptRequestPromise;
  };

  const requestInterrupt = () => {
    if (handled) {
      return;
    }

    handled = true;
    input.onInterruptRequested();
    void requestPendingInterrupt();

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

  return {
    cleanup: () => {
      signal.removeEventListener("abort", requestInterrupt);
      if (sigtermTimer) {
        clearTimeout(sigtermTimer);
      }
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
      }
    },
    requestPendingInterrupt
  };
}

function handleServerRequest(message: JsonRpcRequest, stderrLines: string[]): unknown {
  switch (message.method) {
    case "item/commandExecution/requestApproval":
      stderrLines.push(
        "Declined a Codex command approval request because Nuntius does not support interactive approvals."
      );
      return {
        decision: "decline"
      };
    case "item/fileChange/requestApproval":
      stderrLines.push(
        "Declined a Codex file-change approval request because Nuntius does not support interactive approvals."
      );
      return {
        decision: "decline"
      };
    case "item/permissions/requestApproval":
      stderrLines.push(
        "Declined a Codex permissions approval request because Nuntius does not support interactive approvals."
      );
      return {
        permissions: {},
        scope: "turn"
      };
    case "execCommandApproval":
      stderrLines.push(
        "Declined a legacy Codex command approval request because Nuntius does not support interactive approvals."
      );
      return {
        decision: "denied"
      };
    case "applyPatchApproval":
      stderrLines.push(
        "Declined a legacy Codex patch approval request because Nuntius does not support interactive approvals."
      );
      return {
        decision: "denied"
      };
    case "item/tool/requestUserInput":
      throw new AppServerRequestError(
        -32000,
        "Nuntius does not support interactive request_user_input prompts."
      );
    case "mcpServer/elicitation/request":
      throw new AppServerRequestError(
        -32000,
        "Nuntius does not support MCP elicitation prompts."
      );
    case "item/tool/call":
      throw new AppServerRequestError(
        -32000,
        "Nuntius does not support app-server dynamic tool callbacks."
      );
    case "account/chatgptAuthTokens/refresh":
      throw new AppServerRequestError(
        -32000,
        "Nuntius cannot refresh ChatGPT auth tokens for the app server."
      );
    default:
      throw new AppServerRequestError(
        -32601,
        `Unsupported Codex app server request: ${message.method}`
      );
  }
}

function parseJsonRpcMessage(line: string): JsonRpcMessage | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    if ("id" in parsed && "result" in parsed) {
      return parsed as JsonRpcSuccessResponse;
    }

    if ("id" in parsed && "error" in parsed) {
      return parsed as JsonRpcErrorResponse;
    }

    if ("id" in parsed && "method" in parsed) {
      return parsed as JsonRpcRequest;
    }

    if ("method" in parsed) {
      return parsed as JsonRpcNotification;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeNotification(message: JsonRpcNotification): CodexEvent | undefined {
  switch (message.method) {
    case "thread/started": {
      const threadId = extractThreadId(message.params);
      if (!threadId) {
        return undefined;
      }

      return {
        type: "thread.started",
        thread_id: threadId
      };
    }
    case "turn/completed":
      return {
        type: "turn.completed"
      };
    case "item/completed": {
      const params = readRecord(message.params);
      const item = normalizeThreadItem(readRecord(params, "item"));
      if (!item) {
        return undefined;
      }

      return {
        type: "item.completed",
        item
      };
    }
    default:
      return undefined;
  }
}

function normalizeThreadItem(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!item) {
    return undefined;
  }

  const type = readString(item, "type");
  if (!type) {
    return undefined;
  }

  switch (type) {
    case "agentMessage":
      return {
        type: "agent_message",
        text: readString(item, "text") ?? ""
      };
    case "fileChange":
      return {
        type: "file_change",
        changes: readUnknown(item, "changes") ?? []
      };
    case "userMessage":
      return {
        type: "user_message",
        content: readUnknown(item, "content") ?? []
      };
    default:
      return {
        ...item,
        type: camelToSnakeCase(type)
      };
  }
}

function camelToSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function extractThreadId(value: unknown): string | undefined {
  const record = readRecord(value);
  const direct = readString(record, "threadId");
  if (direct) {
    return direct;
  }

  return readString(readRecord(record, "thread"), "id");
}

function extractTurnId(value: unknown): string | undefined {
  const record = readRecord(value);
  const direct = readString(record, "turnId");
  if (direct) {
    return direct;
  }

  return readString(readRecord(record, "turn"), "id");
}

function buildTurnErrorMessage(error: Record<string, unknown> | undefined): string | undefined {
  if (!error) {
    return undefined;
  }

  const message = readString(error, "message");
  const details = readString(error, "additionalDetails");
  if (message && details) {
    return `${message}\n${details}`;
  }

  return message ?? details;
}

function buildUnexpectedExitError(
  result: AppServerExitResult,
  stderrLines: string[]
): Error {
  const details = stderrLines.length > 0 ? stderrLines.join("\n") : "No stderr output.";
  return new Error(
    `Codex app server exited with code ${result.exitCode}${result.exitSignal ? ` (${result.exitSignal})` : ""}.\n${details}`
  );
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return {
    promise,
    resolve
  };
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

function readRecord(
  value: unknown,
  key?: string
): Record<string, unknown> | undefined {
  const target = key ? readUnknown(value as Record<string, unknown> | undefined, key) : value;
  return typeof target === "object" && target !== null ? (target as Record<string, unknown>) : undefined;
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const candidate = readUnknown(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function readUnknown(
  value: Record<string, unknown> | undefined,
  key: string
): unknown {
  return value?.[key];
}
