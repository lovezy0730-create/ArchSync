/** Registry types shared by the provider surface and the console UI. */
export interface RegistryProjectInfo {
  id: string;
  name: string;
  localPath: string;
  kind?: 'local' | 'remote-only';
  owner: string | null;
  repo: string | null;
  defaultBranch: string | null;
  monitoringEnabled: boolean;
  syncIntervalSeconds: number;
  lastScanAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastScanError?: string | null;
  lastSyncError?: string | null;
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
