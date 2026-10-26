import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectRegistry } from './registry.js';
import type { ProjectEntry } from './projects.js';
import type { LocalDatabase } from './db.js';

const AddLocalSchema = z.object({
  path: z.string().min(1).max(1024),
});

const AddGithubRemoteSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'invalid owner'),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'invalid repo'),
});

export interface RegistryRouteContext {
  registry: ProjectRegistry;
  scheduleRebuild: (entryId: string) => string;
  listEntries: () => ProjectEntry[];
  db: LocalDatabase;
}

interface TimelineRow {
  id: number;
  project_id: string;
  source: string;
  event_type: string;
  remote_id: string;
  title: string;
  detail_json: string;
  occurred_at: string;
}

/**
 * Multi-repo registry REST API (v1.1 阶段 A)。
 *
 * Safety: remove() only unregisters the project in ArchSync — user source
 * code is never touched. Path validation lives in ProjectRegistry.addLocal.
 */
export function registerRegistryRoutes(app: FastifyInstance, ctx: RegistryRouteContext): void {
  app.get('/api/v1/registry', async () => {
    return {
      projects: ctx.registry.list().map((p) => ({
        ...p,
        configModules: ctx.registry.configFor(p.id)?.modules.length ?? 0,
      })),
      totalMonitored: ctx.registry.list().filter((p) => p.monitoringEnabled).length,
    };
  });

  app.post('/api/v1/registry/add-local', async (request, reply) => {
    const parsed = AddLocalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_body', message: 'expected { path: string }' } });
    }
    const result = await ctx.registry.addLocal(parsed.data.path);
    if (result.ok && result.project) {
      // bootstrap the first snapshot for the newly registered project
      ctx.scheduleRebuild(result.project.id);
      return reply.code(201).send({
        ok: true,
        project: { ...result.project, entry: undefined },
      });
    }
    return reply.code(
      result.needsInit ? 422 : 400,
    ).send({
      error: { code: result.needsInit ? 'needs_init' : 'add_failed', message: result.error ?? '添加失败' },
      needsInit: result.needsInit === true,
      initSuggestion: result.initSuggestion,
    });
  });

  app.post('/api/v1/registry/add-github-remote', async (request, reply) => {
    const parsed = AddGithubRemoteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_body', message: 'expected { owner, repo }' } });
    }
    const result = await ctx.registry.addGithubRemote(parsed.data.owner, parsed.data.repo);
    if (!result.ok) {
      return reply.code(400).send({ error: { code: 'add_failed', message: result.error ?? '失败' } });
    }
    // read-only analysis only; cloning lands as a follow-up local add
    return reply.code(200).send(result);
  });

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/disable', async (request, reply) => {
    const updated = ctx.registry.setMonitoring(request.params.id, false);
    if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    return { ok: true, project: updated };
  });

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/enable', async (request, reply) => {
    const updated = ctx.registry.setMonitoring(request.params.id, true);
    if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    return { ok: true, project: updated };
  });

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/resync', async (request, reply) => {
    const registered = ctx.registry.get(request.params.id);
    const entry = ctx.registry.configFor(request.params.id);
    if (!registered || !entry) {
      return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    }
    ctx.registry.reloadEntry(request.params.id);
    const jobId = ctx.scheduleRebuild(request.params.id);
    return reply.code(202).send({ jobId });
  });
  void 0;

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/v1/registry/:id/timeline',
    async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 100) || 100, 300);
      const rows = ctx.db
        .prepare(
          'SELECT * FROM sync_events WHERE project_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?',
        )
        .all(request.params.id, limit) as unknown as TimelineRow[];
      return {
        events: rows.map((r) => ({
          id: r.id,
          projectId: r.project_id,
          source: r.source,
          eventType: r.event_type,
          remoteId: r.remote_id,
          title: r.title,
          detail: JSON.parse(r.detail_json || '{}') as Record<string, unknown>,
          occurredAt: r.occurred_at,
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/remove', async (request, reply) => {
    const removed = ctx.registry.remove(request.params.id);
    if (!removed) return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    return {
      ok: true,
      note: '已从 ArchSync 移除注册；本地源代码与 .archsync 配置均未被删除',
    };
  });
}
