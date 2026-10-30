/**
 * Pages-build stub for the registry API.
 *
 * The GitHub Pages static bundle must never reference /api endpoints
 * (enforced by scripts/verify-pages-dist.mjs). In `--mode pages`, vite aliases
 * `registry-api` to this module: identical call signatures, but every function
 * rejects with StaticModeError. The UI keeps these actions hidden behind
 * capabilities in static mode, so this is a safety net, not an error path.
 */

export class StaticModeError extends Error {
  constructor() {
    super('静态模式下项目管理不可用；请使用本地完整模式（pnpm dev）');
  }
}

export interface RegistryProjectInfo {
  id: string;
  name: string;
  localPath: string;
  owner: string | null;
  repo: string | null;
  defaultBranch: string | null;
  monitoringEnabled: boolean;
  syncIntervalSeconds: number;
  lastScanAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  snapshotVersion: number;
  configModules: number;
  createdAt: string;
}

export interface TimelineEvent {
  id: number;
  projectId: string;
  source: string;
  eventType: string;
  remoteId: string;
  title: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export const registryApi = {
  initPreview: (): Promise<never> => Promise.reject(new StaticModeError()),
  initApply: (): Promise<never> => Promise.reject(new StaticModeError()),
  clone: (): Promise<never> => Promise.reject(new StaticModeError()),
  syncGithub: (): Promise<never> => Promise.reject(new StaticModeError()),
  list: (): Promise<never> => Promise.reject(new StaticModeError()),
  addLocal: (): Promise<never> => Promise.reject(new StaticModeError()),
  analyzeGithub: (): Promise<never> => Promise.reject(new StaticModeError()),
  remove: (): Promise<never> => Promise.reject(new StaticModeError()),
  setMonitoring: (): Promise<never> => Promise.reject(new StaticModeError()),
  resync: (): Promise<never> => Promise.reject(new StaticModeError()),
  timeline: (): Promise<never> => Promise.reject(new StaticModeError()),
};
