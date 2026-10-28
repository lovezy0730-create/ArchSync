
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string }; needsInit?: boolean; initSuggestion?: unknown }
      | null;
    const err = new Error(body?.error?.message ?? `HTTP ${res.status}`) as Error & {
      status?: number;
      code?: string;
      payload?: unknown;
    };
    err.status = res.status;
    err.code = body?.error?.code ?? 'http_error';
    err.payload = body;
    throw err;
  }
  return (await res.json()) as T;
}

export const registryApi = {
  list: () => req<{ projects: RegistryProjectInfo[]; totalMonitored: number }>('/api/v1/registry'),
  addLocal: (path: string) =>
    req<{ ok: boolean; project: RegistryProjectInfo }>('/api/v1/registry/add-local', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  initApply: (path: string, yaml: string) =>
    req<{ ok: boolean; project: RegistryProjectInfo }>('/api/v1/registry/init-apply', {
      method: 'POST',
      body: JSON.stringify({ path, yaml }),
    }),
  syncGithub: (id: string) =>
    req<{ ok: boolean; state: string; events: number; errors: string[] }>(
      `/api/v1/registry/${encodeURIComponent(id)}/sync-github`,
      { method: 'POST' },
    ),
  analyzeGithub: (owner: string, repo: string) =>
    req<{ ok: boolean; remoteOnly?: boolean; facts?: Record<string, unknown> }>(
      '/api/v1/registry/add-github-remote',
      { method: 'POST', body: JSON.stringify({ owner, repo }) },
    ),
  remove: (id: string) =>
    req<{ ok: boolean; note: string }>(`/api/v1/registry/${encodeURIComponent(id)}/remove`, {
      method: 'POST',
    }),
  setMonitoring: (id: string, enabled: boolean) =>
    req<{ ok: boolean; project: RegistryProjectInfo }>(
      `/api/v1/registry/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),
  resync: (id: string) =>
    req<{ jobId: string }>(`/api/v1/registry/${encodeURIComponent(id)}/resync`, { method: 'POST' }),
  timeline: (id: string, limit = 100) =>
    req<{ events: TimelineEvent[] }>(`/api/v1/registry/${encodeURIComponent(id)}/timeline?limit=${limit}`),
};
