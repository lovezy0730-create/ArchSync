import type {
  ModuleDetail,
  ProjectSummary,
  Snapshot,
  SyncJobStatus,
} from '@archsync/contracts';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit & { user?: string }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.user) headers['x-archsync-user'] = init.user;
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `HTTP ${res.status}`,
      body,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  projects: () => request<{ projects: ProjectSummary[] }>('/api/v1/projects'),
  snapshot: (projectId: string) => request<Snapshot>(`/api/v1/projects/${projectId}/snapshot`),
  module: (projectId: string, moduleId: string) =>
    request<ModuleDetail>(`/api/v1/projects/${projectId}/modules/${moduleId}`),
  team: (projectId: string) =>
    request<{ team: Array<{ login: string; name: string; role: string }>; demo: boolean }>(
      `/api/v1/projects/${projectId}/team`,
    ),
  patchAnnotation: (
    projectId: string,
    moduleId: string,
    body: { text: string; expectedRevision: number },
    user: string,
  ) =>
    request<{ revision: number; text: string }>(
      `/api/v1/projects/${projectId}/modules/${moduleId}/annotation`,
      { method: 'PATCH', body: JSON.stringify(body), user },
    ),
  sync: (projectId: string) =>
    request<{ jobId: string }>(`/api/v1/projects/${projectId}/sync`, { method: 'POST' }),
  job: (jobId: string) => request<SyncJobStatus>(`/api/v1/jobs/${jobId}`),
};
