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

type ReloadableBridgeConfig = Omit<BridgeConfig, "codexBinary" | "sessionStorePath">;

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
    getRepositoryRegistrySnapshot: () => buildRepositoryRegistrySnapshot(config),
    reloadRepositoryRegistry: () => {
      const refreshed = loadConfig();
      Object.assign(config, getReloadableBridgeConfig(refreshed));
      return buildRepositoryRegistrySnapshot(config);
    },
    reconcileSessionBindings: () => bridge.reconcileSessionBindings()
  };
}

function buildRepositoryRegistrySnapshot(config: BridgeConfig): RepositoryRegistrySnapshot {
  return {
    defaultRepositoryId: config.defaultRepositoryId,
    repositoryTargets: config.repositoryTargets,
    source: config.configFilePath ? "file" : "env",
    sourcePath: config.repositoryRegistryPath ?? config.configFilePath
  };
}

function getReloadableBridgeConfig(config: BridgeConfig): ReloadableBridgeConfig {
  const { codexBinary: _codexBinary, sessionStorePath: _sessionStorePath, ...reloadable } = config;
  return reloadable;
}
