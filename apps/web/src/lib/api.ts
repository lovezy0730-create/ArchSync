import type {
  ArchitectureLevel,
  ArchitectureResponse,
  CodeIndexStatus,
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

export interface RequestOptions {
  /** Hard upper bound for one request; prevents an indefinite loading state. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(
  path: string,
  init?: RequestInit & { user?: string },
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.user) {
    // HTTP header values must be ISO-8859-1; display names can be any UTF-8.
    headers['x-archsync-user'] = encodeURIComponent(init.user);
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(new DOMException('request timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: 'same-origin', signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new ApiError(0, 'timeout', `请求超时（${Math.round(timeoutMs / 1000)} 秒）：${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
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

export interface DiagnosticsInfo {
  app: { name: string; version: string; sha: string; builtAt: string | null; dirty: boolean | null };
  agent: { version: string; node: string; pid: number; uptimeMs: number; phase: string };
  database: { path: string; schemaVersion: number | null };
  dataDir: string;
  logDir: string | null;
  startup: {
    startedAt: string;
    phase: string;
    listenMs: number | null;
    restoredProjects: number;
    background: { total: number; completed: number; failed: number; running: number };
    lastError: string | null;
    uptimeMs: number;
  };
  projects: Array<{
    id: string; name: string; rootDir: string; kind: string | null;
    snapshotVersion: number | null;
    codeIndex: { files: number; symbols: number; stale: number } | null;
    codeState: { state: string; error: string | null; scannedAt: string | null } | null;
  }>;
  environment: Record<string, unknown>;
}

export interface MeInfo {
  mode: 'mock' | 'code' | 'off';
  authenticated: boolean;
  identity: string | null;
}

export const api = {
  me: () => request<MeInfo>('/api/v1/me'),
  diagnostics: () => request<DiagnosticsInfo>('/api/v1/diagnostics', undefined, { timeoutMs: 8_000 }),
  login: (code: string) =>
    request<{ ok: boolean }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  projects: () => request<{ projects: ProjectSummary[] }>('/api/v1/projects'),
  snapshot: (projectId: string) =>
    request<Snapshot>(`/api/v1/projects/${projectId}/snapshot`, undefined, { timeoutMs: 20_000 }),
  snapshotStatus: (projectId: string) =>
    request<{
      projectId: string;
      available: boolean;
      version: number | null;
      generatedAt: string | null;
      contentHash: string | null;
      job: { id: string; state: 'running' | 'done' | 'error'; error: string | null } | null;
    }>(`/api/v1/projects/${projectId}/snapshot/status`, undefined, { timeoutMs: 8_000 }),
  gitInfo: (projectId: string) =>
    request<{ available: boolean; branch: string | null; head: string | null; dirty: number | null; error: string | null }>(
      `/api/v1/projects/${projectId}/git`,
      undefined,
      { timeoutMs: 8_000 },
    ),
  codeIndexStatus: (projectId: string) =>
    request<CodeIndexStatus>(`/api/v1/projects/${projectId}/code-index/status`, undefined, { timeoutMs: 8_000 }),
  architecture: (
    projectId: string,
    query: { level: ArchitectureLevel; moduleId?: string; filePath?: string; systemId?: string },
  ) => {
    const params = new URLSearchParams({ level: query.level });
    if (query.moduleId) params.set('moduleId', query.moduleId);
    if (query.filePath) params.set('filePath', query.filePath);
    if (query.systemId) params.set('systemId', query.systemId);
    return request<ArchitectureResponse>(
      `/api/v1/projects/${projectId}/architecture?${params.toString()}`,
      undefined,
      { timeoutMs: 20_000 },
    );
  },
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
