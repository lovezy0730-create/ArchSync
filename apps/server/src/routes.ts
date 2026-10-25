import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ModuleDetail, ProjectSummary } from '@archsync/contracts';
import { parseProjectConfig } from '@archsync/config';
import type { ProjectEntry } from './projects.js';
import { emptyProjectState, type StateStore } from './store/index.js';

const AnnotationPatchSchema = z.object({
  text: z.string().max(2000),
  expectedRevision: z.number().int().min(1),
});

const ValidateConfigSchema = z.object({ config: z.string().max(1024 * 1024) });

export interface RouteContext {
  entries: Map<string, ProjectEntry>;
  store: StateStore;
  devAuthMode: 'mock' | 'off';
  /** enqueue a rebuild in the background; returns the job id immediately */
  scheduleRebuild: (entry: ProjectEntry) => string;
  /** used when a request needs the rebuild finished before replying */
  scheduleRebuildAndWait?: (entry: ProjectEntry) => Promise<{ jobId: string }>;
}

function requireIdentity(ctx: RouteContext, request: { headers: Record<string, unknown> }): string | null {
  if (ctx.devAuthMode !== 'mock') return null;
  const raw = request.headers['x-archsync-user'];
  const name = Array.isArray(raw) ? raw[0] : raw;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64) return null;
  return name.trim();
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/projects', async () => {
    const summaries: ProjectSummary[] = [...ctx.entries.values()].map((entry) => {
      const state = ctx.store.project(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        github: entry.config.project.github,
        rootDir: entry.rootDir.replace(/\\/g, '/'),
        demoCollab: entry.demoCollabPath !== null,
        moduleCount: entry.config.modules.length,
        currentVersion: state.currentSnapshot?.version ?? 0,
      };
    });
    return { projects: summaries };
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/snapshot', async (request, reply) => {
    const entry = ctx.entries.get(request.params.id);
    if (!entry) {
      return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
    }
    let snapshot = ctx.store.project(entry.id).currentSnapshot;
    if (!snapshot) {
      await ctx.scheduleRebuildAndWait?.(entry);
      snapshot = ctx.store.project(entry.id).currentSnapshot;
    }
    if (!snapshot) {
      return reply.code(503).send({ error: { code: 'snapshot_unavailable', message: '快照暂不可用' } });
    }
    const etag = `W/"v${snapshot.version}-${snapshot.contentHash}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.headers({ ETag: etag }).send(snapshot);
  });

  app.get<{ Params: { id: string; moduleId: string } }>(
    '/api/v1/projects/:id/modules/:moduleId',
    async (request, reply) => {
      const entry = ctx.entries.get(request.params.id);
      if (!entry) {
        return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
      }
      const state = ctx.store.project(entry.id);
      const module = state.currentSnapshot?.modules.find((m) => m.id === request.params.moduleId);
      if (!module) {
        return reply.code(404).send({ error: { code: 'module_not_found', message: '模块不存在' } });
      }
      const detail: ModuleDetail = {
        ...module,
        annotation: state.annotations[module.id] ?? {
          text: '',
          revision: 1,
          updatedBy: null,
          updatedAt: null,
        },
      };
      return detail;
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/team', async (request, reply) => {
    const entry = ctx.entries.get(request.params.id);
    if (!entry) {
      return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
    }
    const team = new Map<string, { login: string; name: string; role: string }>();
    for (const m of entry.config.modules) {
      for (const login of m.owners) team.set(login, { login, name: login, role: 'owner' });
    }
    if (entry.demoCollabPath) {
      try {
        const raw = JSON.parse(readFileSync(entry.demoCollabPath, 'utf8')) as {
          team?: Array<{ login: string; name: string; role: string }>;
        };
        for (const member of raw.team ?? []) team.set(member.login, member);
      } catch {
        // fixture unreadable → fall back to owners from the config
      }
    }
    return { team: [...team.values()], demo: entry.demoCollabPath !== null };
  });

  app.patch<{ Params: { id: string; moduleId: string } }>(
    '/api/v1/projects/:id/modules/:moduleId/annotation',
    async (request, reply) => {
      const entry = ctx.entries.get(request.params.id);
      if (!entry) {
        return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
      }
      const parsed = AnnotationPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid' } });
      }
      const identity = requireIdentity(ctx, request);
      if (!identity) {
        return reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: '缺少或无效的 x-archsync-user 身份头' } });
      }
      const moduleId = request.params.moduleId;
      if (!entry.config.modules.some((m) => m.id === moduleId)) {
        return reply.code(404).send({ error: { code: 'module_not_found', message: '模块不存在' } });
      }

      // strip control characters (keep \t \n \r) without a control-char regex
      const text = [...parsed.data.text]
        .filter((ch) => {
          const code = ch.codePointAt(0)!;
          if (code === 9 || code === 10 || code === 13) return true;
          return code > 31;
        })
        .join('');
      const result = { outcome: 'ok' as 'ok' | 'conflict', revision: 1, text: '' };

      await ctx.store.mutate((data) => {
        const p = data.projects[entry.id] ?? emptyProjectState();
        const existing = p.annotations[moduleId] ?? {
          text: '',
          revision: 1,
          updatedBy: null,
          updatedAt: null,
        };
        if (existing.revision !== parsed.data.expectedRevision) {
          result.outcome = 'conflict';
          result.revision = existing.revision;
          result.text = existing.text;
          return;
        }
        const revision = existing.revision + 1;
        const now = new Date().toISOString();
        p.annotations[moduleId] = { text, revision, updatedBy: identity, updatedAt: now };
        p.annotationRevisions.push({ moduleId, revision, text, author: identity, createdAt: now });
        result.revision = revision;
        result.text = text;
      });

      if (result.outcome === 'conflict') {
        return reply.code(409).send({
          error: { code: 'annotation_conflict', message: '备注已被他人修改，请基于最新内容重试' },
          current: { text: result.text, revision: result.revision },
        });
      }
      return { revision: result.revision, text: result.text };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/sync', async (request, reply) => {
    const entry = ctx.entries.get(request.params.id);
    if (!entry) {
      return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
    }
    const jobId = ctx.scheduleRebuild(entry);
    return reply.code(202).send({ jobId });
  });

  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', async (request, reply) => {
    for (const entry of ctx.entries.values()) {
      const job = ctx.store.project(entry.id).jobs[request.params.jobId];
      if (job) return job;
    }
    return reply.code(404).send({ error: { code: 'job_not_found', message: '任务不存在' } });
  });

  app.post('/api/v1/config/validate', async (request, reply) => {
    const parsed = ValidateConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_body', message: 'expected { config: string }' } });
    }
    const result = parseProjectConfig(parsed.data.config);
    return {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      moduleCount: result.config?.modules.length ?? 0,
      layerCount: result.config?.layers.length ?? 0,
    };
  });
}

