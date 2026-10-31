import type { CodeRelation, SourceFile } from '@archsync/contracts';

export interface CodeIndexResponse {
  projectId: string;
  origin: 'planned' | 'inferred';
  state: 'idle' | 'scanning' | 'ready' | 'error' | 'unavailable';
  error: string | null;
  modules: { id: string; label: string }[];
  files: SourceFile[];
  trustedRelations: CodeRelation[];
  summary: { fresh: number; stale: number; partial: number; unavailable: number; unsupported: number; freshSymbols: number; historicalSymbols: number };
}
export interface SourceResponse { content: string; indexedContentMatches: boolean; status: string }
export async function loadCodeIndex(projectId: string): Promise<CodeIndexResponse> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/code-index`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`索引请求失败：HTTP ${response.status}`);
  return await response.json() as CodeIndexResponse;
}
export async function loadCodeSource(projectId: string, filePath: string): Promise<SourceResponse> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/source?path=${encodeURIComponent(filePath)}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`源码不可读取：HTTP ${response.status}`);
  return await response.json() as SourceResponse;
}
