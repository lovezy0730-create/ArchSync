import type { ModuleDetail } from '@archsync/contracts';
import { api } from './api.js';
import { SERVER_CAPABILITIES, type AnnotationWriteResult, type DataProvider, type TeamInfo } from './data-provider.js';

/** Local full mode: talks to the Fastify server (REST + WS live in presence-client). */
export function createServerProvider(): DataProvider {
  return {
    mode: 'server',
    capabilities: SERVER_CAPABILITIES,
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
      const result = await api.patchAnnotation(projectId, moduleId, { text, expectedRevision }, user);
      return { ok: true, revision: result.revision, text: result.text };
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
