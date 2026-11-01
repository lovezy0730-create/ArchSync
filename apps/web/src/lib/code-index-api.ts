import type {
  ArchitectureLevel,
  ArchitectureResponse,
  CodeIndexStatus,
  CodeRelation,
  SourceFile,
} from '@archsync/contracts';

export interface CodeIndexResponse {
  projectId: string;
  origin: 'planned' | 'inferred';
  state: 'idle' | 'scanning' | 'ready' | 'error' | 'unavailable';
  error: string | null;
  systems?: { id: string; label: string; order: number }[];
  modules: Array<{
    id: string;
    label: string;
    systemId?: string | null;
    parentId?: string | null;
    layer?: string;
    confidence?: 'high' | 'medium' | 'low' | 'none';
    discoveryEvidence?: string[];
  }>;
  files: SourceFile[];
  changes: { path: string; kind: 'added' | 'modified' | 'deleted'; untracked: boolean }[] | null;
  trustedRelations: CodeRelation[];
  summary: { fresh: number; stale: number; partial: number; unavailable: number; unsupported: number; freshSymbols: number; historicalSymbols: number };
  /** Sum of committed file revisions; changes whenever the index updates. */
  indexVersion?: number;
}
export interface SourceResponse { content: string; indexedContentMatches: boolean; status: string }
export interface WorkspaceSelection { moduleId: string | null; filePath: string | null; symbolUid: string | null }
export async function loadCodeIndex(projectId: string): Promise<CodeIndexResponse> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/code-index`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`索引请求失败：HTTP ${response.status}`);
  return await response.json() as CodeIndexResponse;
}
export async function loadCodeIndexStatus(projectId: string): Promise<CodeIndexStatus> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/code-index/status`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`索引状态请求失败：HTTP ${response.status}`);
  return await response.json() as CodeIndexStatus;
}
export async function loadArchitecture(
  projectId: string,
  query: { level: ArchitectureLevel; moduleId?: string; filePath?: string; systemId?: string },
): Promise<ArchitectureResponse> {
  const params = new URLSearchParams({ level: query.level });
  if (query.moduleId) params.set('moduleId', query.moduleId);
  if (query.filePath) params.set('filePath', query.filePath);
  if (query.systemId) params.set('systemId', query.systemId);
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/architecture?${params.toString()}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`架构投影请求失败：HTTP ${response.status}`);
  return await response.json() as ArchitectureResponse;
}
export async function loadCodeSource(projectId: string, filePath: string): Promise<SourceResponse> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/source?path=${encodeURIComponent(filePath)}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`源码不可读取：HTTP ${response.status}`);
  return await response.json() as SourceResponse;
}
export async function loadWorkspace(projectId: string): Promise<WorkspaceSelection> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/workspace`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`工作台状态不可用：HTTP ${response.status}`);
  return await response.json() as WorkspaceSelection;
}
export async function saveWorkspace(projectId: string, selection: WorkspaceSelection): Promise<void> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/workspace`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) });
  if (!response.ok) throw new Error(`工作台状态保存失败：HTTP ${response.status}`);
}
export async function loadActiveProject(): Promise<string | null> {
  const response = await fetch('/api/v1/workspace/active-project', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`项目状态不可用：HTTP ${response.status}`);
  return ((await response.json()) as { projectId: string | null }).projectId;
}
export async function saveActiveProject(projectId: string): Promise<void> {
  const response = await fetch('/api/v1/workspace/active-project', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) });
  if (!response.ok) throw new Error(`项目状态保存失败：HTTP ${response.status}`);
}
