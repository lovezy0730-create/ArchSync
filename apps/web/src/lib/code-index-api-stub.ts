import type { CodeIndexResponse, SourceResponse, WorkspaceSelection } from './code-index-api.js';
export async function loadCodeIndex(_projectId: string): Promise<CodeIndexResponse> { throw new Error('静态模式不提供本地源码索引'); }
export async function loadCodeSource(_projectId: string, _filePath: string): Promise<SourceResponse> { throw new Error('静态模式不提供本地源码'); }
export async function loadWorkspace(_projectId: string): Promise<WorkspaceSelection> { throw new Error('静态模式不提供工作台状态'); }
export async function saveWorkspace(_projectId: string, _selection: WorkspaceSelection): Promise<void> { throw new Error('静态模式不提供工作台状态'); }
