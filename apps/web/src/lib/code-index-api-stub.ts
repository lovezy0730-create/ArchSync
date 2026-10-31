import type { CodeIndexResponse, SourceResponse } from './code-index-api.js';
export async function loadCodeIndex(_projectId: string): Promise<CodeIndexResponse> { throw new Error('静态模式不提供本地源码索引'); }
export async function loadCodeSource(_projectId: string, _filePath: string): Promise<SourceResponse> { throw new Error('静态模式不提供本地源码'); }
