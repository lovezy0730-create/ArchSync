import type { ModuleDetail } from '@archsync/contracts';
import { api, ApiError } from './api.js';
import { registryApi } from './registry-api.js';
import {
  SERVER_CAPABILITIES,
  type AnnotationWriteResult,
  type AuthProbe,
  type DataProvider,
  type TeamInfo,
} from './data-provider.js';

/** Local full mode: talks to the Fastify server (REST + WS live in presence-client). */
export function createServerProvider(): DataProvider {
  return {
    mode: 'server',
    capabilities: SERVER_CAPABILITIES,
    registry: registryApi,
    probeAuth: async (): Promise<AuthProbe> => api.me(),
    submitAccessCode: async (code) => {
      try {
        await api.login(code);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof ApiError && err.status === 401 ? '访问码不正确，请重试。' : `验证失败: ${(err as Error).message}` };
      }
    },
    listProjects: () => api.projects(),
    loadSnapshot: (projectId) => api.snapshot(projectId),
    loadModule: (projectId, moduleId) => api.module(projectId, moduleId),
    loadTeam: (projectId): Promise<TeamInfo> => api.team(projectId),
    async saveAnnotation(
      projectId: string,
      moduleId: string,
      text: string,
      expectedRevision: number,
      user: string,
    ): Promise<AnnotationWriteResult> {
      try {
        const result = await api.patchAnnotation(projectId, moduleId, { text, expectedRevision }, user);
        return { ok: true, revision: result.revision, text: result.text };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          return { ok: false, conflict: true, message: '备注已被其他成员修改，已为你加载最新版本，请基于最新内容重试。' };
        }
        return { ok: false, message: `保存失败: ${(err as Error).message}` };
      }
    },
    async resync(projectId: string): Promise<void> {
      const { jobId } = await api.sync(projectId);
      for (let i = 0; i < 60; i++) {
        const job = await api.job(jobId);
        if (job.state === 'done' || job.state === 'error') break;
        await new Promise((r) => setTimeout(r, 150));
      }
    },
  };
}

void ({} as Record<string, ModuleDetail>);
