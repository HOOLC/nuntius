import { CodexRunner } from "./codex-runner.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { InteractionRouter } from "./interaction-router.js";
import { SerialTurnQueue } from "./serial-turn-queue.js";
import { CodexBridgeService, type SessionReconciliationResult } from "./service.js";
import { FileSessionStore } from "./session-store.js";

export interface RepositoryRegistrySnapshot {
  defaultRepositoryId: string;
  repositoryTargets: BridgeConfig["repositoryTargets"];
  source: "file" | "env";
  sourcePath?: string;
}

export interface BridgeRuntime {
  config: BridgeConfig;
  sessionStore: FileSessionStore;
  queue: SerialTurnQueue;
  runner: CodexRunner;
  bridge: CodexBridgeService;
  router: InteractionRouter;
  getRepositoryRegistrySnapshot(): RepositoryRegistrySnapshot;
  reloadRepositoryRegistry(): RepositoryRegistrySnapshot;
  reconcileSessionBindings(): Promise<SessionReconciliationResult>;
}

export function createBridgeRuntime(config: BridgeConfig = loadConfig()): BridgeRuntime {
  const sessionStore = new FileSessionStore(config.sessionStorePath);
  const queue = new SerialTurnQueue();
  const runner = new CodexRunner(config.codexBinary);
  const bridge = new CodexBridgeService(config, sessionStore, queue, runner);
  const router = new InteractionRouter(bridge);

  return {
    config,
    sessionStore,
    queue,
    runner,
    bridge,
    router,
    getRepositoryRegistrySnapshot: () => ({
      defaultRepositoryId: config.defaultRepositoryId,
      repositoryTargets: config.repositoryTargets,
      source: config.configFilePath ? "file" : "env",
      sourcePath: config.repositoryRegistryPath ?? config.configFilePath
    }),
    reloadRepositoryRegistry: () => {
      const refreshed = loadConfig();

      config.defaultRepositoryId = refreshed.defaultRepositoryId;
      config.requireExplicitRepositorySelection = refreshed.requireExplicitRepositorySelection;
      config.handlerWorkspacePath = refreshed.handlerWorkspacePath;
      config.handlerSandboxMode = refreshed.handlerSandboxMode;
      config.handlerModel = refreshed.handlerModel;
      config.maxHandlerStepsPerTurn = refreshed.maxHandlerStepsPerTurn;
      config.repositoryRegistryPath = refreshed.repositoryRegistryPath;
      config.repositoryTargets = refreshed.repositoryTargets;
      config.maxResponseChars = refreshed.maxResponseChars;
      config.configFilePath = refreshed.configFilePath;

      return {
        defaultRepositoryId: config.defaultRepositoryId,
        repositoryTargets: config.repositoryTargets,
        source: config.configFilePath ? "file" : "env",
        sourcePath: config.repositoryRegistryPath ?? config.configFilePath
      };
    },
    reconcileSessionBindings: () => bridge.reconcileSessionBindings()
  };
}
