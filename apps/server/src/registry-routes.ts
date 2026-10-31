import { loadCollab } from './github.js';
import { GithubApiClient } from './sync/github-client.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectRegistry } from './registry.js';
import { loadProjectEntry } from './projects.js';
import { join } from 'node:path';
import type { ProjectEntry } from './projects.js';
import type { LocalDatabase } from './db.js';
import { isSameOrigin } from './routes.js';

const AddLocalSchema = z.object({
  path: z.string().min(1).max(1024),
});

const AddGithubRemoteSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'invalid owner'),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'invalid repo'),
});

const InitApplySchema = z.object({
  path: z.string().min(1).max(1024),
  yaml: z.string().min(1).max(1024 * 1024),
});

export interface RegistryRouteContext {
  registry: ProjectRegistry;
  scheduleRebuild: (entryId: string) => string;
  listEntries: () => ProjectEntry[];
  db: LocalDatabase;
  /** run the GitHub worker immediately for one project (手动立即同步) */
  syncGithubNow: (entryId: string) => Promise<{
    state: 'completed' | 'completed_no_change' | 'failed' | 'rate_limited' | 'skipped';
    events: number;
    errors: string[];
  }>;
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
  // 每个写接口统一同源断言（CSRF 硬化）；避免新增接口时遗漏。
  // code 模式下的会话要求由 index.ts 的统一 onRequest 鉴权门覆盖。
  const requireSameOrigin: import('fastify').preHandlerHookHandler = async (request, reply) => {
    if (!isSameOrigin(request)) {
      return reply.code(403).send({ error: { code: 'cross_origin_blocked', message: '跨源写请求被拒绝' } });
    }
  };

  app.post('/api/v1/registry/init-preview', {preHandler:requireSameOrigin}, async (request,reply) => {
    const body = AddLocalSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({error:{message:'路径无效'}});
    try { return await ctx.registry.initPreview(body.data.path); }
    catch (err) { return reply.code(400).send({error:{message:(err as Error).message}}); }
  });
  app.post('/api/v1/registry/clone', {preHandler:requireSameOrigin}, async (request,reply) => {
    const body = AddGithubRemoteSchema.extend({parent:z.string().min(1).max(1024)}).safeParse(request.body);
    if (!body.success) return reply.code(400).send({error:{message:'克隆参数无效'}});
    try { return await ctx.registry.clonePublic(body.data.owner,body.data.repo,body.data.parent); }
    catch { return reply.code(400).send({error:{message:'克隆失败：检查网络、Git 安装和目录权限后重试'}}); }
  });

  app.get('/api/v1/registry', async () => {
    return {
      projects: ctx.registry.list().map((p) => ({
        ...p,
        configModules: ctx.registry.configFor(p.id)?.modules.length ?? 0,
      })),
      totalMonitored: ctx.registry.list().filter((p) => p.monitoringEnabled).length,
    };
  });

  app.get<{Params:{id:string}}>('/api/v1/registry/:id/github', async (request,reply) => {
    const entry = ctx.registry.liveEntries.get(request.params.id);
    if (!entry) return reply.code(404).send({error:{message:'项目不存在'}});
    const cache = new GithubApiClient(ctx.db,()=>null);
    const {owner,repo} = entry.config.project.github;
    return {collab:await loadCollab(entry,null,cache),repository:`${owner}/${repo}`,
      head:cache.readCache(entry.id,'head'),ci:cache.readCache(entry.id,'head-ci')};
  });

  app.post('/api/v1/registry/add-local', { preHandler: requireSameOrigin }, async (request, reply) => {
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

  app.post('/api/v1/registry/add-github-remote', { preHandler: requireSameOrigin }, async (request, reply) => {
    const parsed = AddGithubRemoteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_body', message: 'expected { owner, repo }' } });
    }
    const result = await ctx.registry.addRemoteOnly(parsed.data.owner, parsed.data.repo);
    if (!result.ok) {
      return reply.code(400).send({ error: { code: 'add_failed', message: result.error ?? '失败' } });
    }
    if (result.project) { ctx.scheduleRebuild(result.project.id); void ctx.syncGithubNow(result.project.id); }
    return reply.code(201).send(result);
  });

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/disable', { preHandler: requireSameOrigin }, async (request, reply) => {
    const updated = ctx.registry.setMonitoring(request.params.id, false);
    if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    return { ok: true, project: updated };
  });

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/enable', { preHandler: requireSameOrigin }, async (request, reply) => {
    const updated = ctx.registry.setMonitoring(request.params.id, true);
    if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    return { ok: true, project: updated };
  });

  // 手动「立即同步」：真正触发 GitHub worker（条件请求 + 时间线事件 + 快照重建），
  // 与 resync（本地重扫）语义分开。等待完成并返回任务状态，限流时如实报告。
  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/sync-github', { preHandler: requireSameOrigin }, async (request, reply) => {
    const registered = ctx.registry.get(request.params.id);
    const entry = ctx.registry.configFor(request.params.id);
    if (!registered || !entry) {
      return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    }
    if (!registered.monitoringEnabled) {
      return reply.code(409).send({ error: { code: 'monitoring_disabled', message: '该项目已暂停监控' } });
    }
    const result = await ctx.syncGithubNow(request.params.id);
    return {
      ok: result.state !== 'failed' && result.state !== 'rate_limited',
      state: result.state,
      events: result.events,
      errors: result.errors,
      syncedAt: new Date().toISOString(),
    };
  });

  // 一键接入闭环（P0 4.1）：用户确认建议后写入 .archsync/project.yaml 并注册监控。
  // 不覆盖已有有效配置；写入失败如实报错。
  app.post('/api/v1/registry/init-apply', { preHandler: requireSameOrigin }, async (request, reply) => {
    const parsed = InitApplySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_body', message: 'expected { path, yaml }' } });
    }
    const result = await ctx.registry.initApply(parsed.data.path, parsed.data.yaml);
    if (result.ok && result.project) {
      ctx.scheduleRebuild(result.project.id);
      return reply.code(201).send({ ok: true, project: { ...result.project, entry: undefined } });
    }
    return reply.code(result.needsInit ? 422 : 400).send({
      error: { code: result.needsInit ? 'needs_init' : 'init_failed', message: result.error ?? '初始化失败' },
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/resync', { preHandler: requireSameOrigin }, async (request, reply) => {
    const registered = ctx.registry.get(request.params.id);
    const entry = ctx.registry.configFor(request.params.id);
    if (!registered || !entry) {
      return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    }
    if (registered.kind === 'remote-only') return reply.code(409).send({error:{code:'remote_only',message:'远端项目请刷新 GitHub，无本地文件扫描'}});
    const reloaded = loadProjectEntry(join(registered.localPath, '.archsync', 'project.yaml'));
    if ('error' in reloaded) {
      return reply.code(409).send({ error: { code: 'reload_failed', message: reloaded.error } });
    }
    ctx.registry.updateEntry(request.params.id, reloaded);
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

  app.post<{ Params: { id: string } }>('/api/v1/registry/:id/remove', { preHandler: requireSameOrigin }, async (request, reply) => {
    const removed = ctx.registry.remove(request.params.id);
    if (!removed) return reply.code(404).send({ error: { code: 'not_found', message: '项目不存在' } });
    return {
      ok: true,
      note: '已从 ArchSync 移除注册；本地源代码与 .archsync 配置均未被删除',
    };
  });
}
