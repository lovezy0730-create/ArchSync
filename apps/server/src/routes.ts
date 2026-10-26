import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ModuleDetail, ProjectSummary } from '@archsync/contracts';
import { parseProjectConfig } from '@archsync/config';
import type { ProjectEntry } from './projects.js';
import { emptyProjectState, type StateStore } from './store/index.js';
import type { AuthMode } from './env.js';
import {
  SessionStore,
  buildClearedSessionCookie,
  buildSessionCookie,
  sessionTokenFromRequest,
} from './auth.js';
import { LoginRateLimiter, constantTimeEquals } from './auth-rate-limit.js';

const AnnotationPatchSchema = z.object({
  text: z.string().max(2000),
  expectedRevision: z.number().int().min(1),
});

const ValidateConfigSchema = z.object({ config: z.string().max(1024 * 1024) });
const LoginSchema = z.object({ code: z.string().min(1).max(256) });

export interface RouteContext {
  entries: Map<string, ProjectEntry>;
  store: StateStore;
  authMode: AuthMode;
  authCode: string | null;
  sessions: SessionStore;
  loginLimiter: LoginRateLimiter;
  /** true when the deployment serves over HTTPS (adds the Secure cookie flag) */
  secureCookies: boolean;
  /** enqueue a rebuild in the background; returns the job id immediately */
  scheduleRebuild: (entry: ProjectEntry) => string;
  /** used when a request needs the rebuild finished before replying */
  scheduleRebuildAndWait?: (entry: ProjectEntry) => Promise<{ jobId: string }>;
}

/**
 * Resolve the acting display name:
 * - mock/off: x-archsync-user header only (loopback dev demo).
 * - code: valid session cookie AND the display-name header.
 * Returns null when unauthenticated; callers must reject with 401.
 */
/**
 * CSRF hardening for state-changing requests: same-origin assertion.
 * SameSite=Lax already keeps the session cookie off cross-site POSTs in
 * modern browsers; this adds an explicit check for clients that send an
 * Origin header (all browsers do on cross-origin writes).
 */
export function isSameOrigin(
  request: { headers: Record<string, unknown>; protocol?: string; host?: unknown; ip?: string },
): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true; // non-browser clients
  try {
    const originHost = new URL(origin).host;
    const hostRaw = request.headers.host;
    const hostHeader = String(Array.isArray(hostRaw) ? hostRaw[0] ?? '' : hostRaw).trim();
    if (hostHeader.length === 0) return false;
    if (originHost === hostHeader) return true;
    // loopback pairs allowed in local deployments (mirrors the CORS layer)
    const base = (h: string): string => h.toLowerCase().split(':')[0] ?? '';
    const isLoopback = (h: string): boolean => ['localhost', '127.0.0.1', '::1'].includes(base(h));
    if (isLoopback(originHost) && isLoopback(hostHeader)) return true;
    return false;
  } catch {
    return false;
  }
}

function requireIdentity(ctx: RouteContext, request: { headers: Record<string, unknown> }): string | null {
  if (ctx.authMode === 'code') {
    const token = sessionTokenFromRequest(request);
    if (!ctx.sessions.validate(token)) return null;
  } else if (ctx.authMode !== 'mock') {
    return null;
  }
  const raw = request.headers['x-archsync-user'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 192) return null;
  // clients percent-encode non-ISO-8859-1 display names; tolerate raw ASCII too
  let name = value;
  try {
    name = decodeURIComponent(value);
  } catch {
    name = value;
  }
  name = name.trim();
  if (name.length === 0 || name.length > 64) return null;
  return name;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/me', async (request, reply) => {
    const token = sessionTokenFromRequest(request);
    const authenticated =
      ctx.authMode === 'code'
        ? ctx.sessions.validate(token)
        : ctx.authMode === 'mock'; // mock: identity comes per-request via header
    const identity = requireIdentity(ctx, request);
    return reply
      .headers({ 'cache-control': 'no-store' })
      .send({ mode: ctx.authMode, authenticated, identity });
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    if (!isSameOrigin(request)) {
      return reply.code(403).send({ error: { code: 'cross_origin_blocked', message: '跨源写请求被拒绝' } });
    }
    if (ctx.authMode !== 'code' || ctx.authCode === null) {
      return reply.code(400).send({
        error: { code: 'auth_mode_disabled', message: '当前部署未启用访问码鉴权' },
      });
    }
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_body', message: 'expected { code: string }' } });
    }
    if (ctx.loginLimiter.isBlocked(request.ip)) {
      return reply.code(429).send({
        error: { code: 'too_many_attempts', message: '尝试次数过多，请 15 分钟后再试' },
      });
    }
    if (!constantTimeEquals(parsed.data.code, ctx.authCode)) {
      // constant-time compare via hashed digests prevents timing oracles
      ctx.loginLimiter.recordFailure(request.ip);
      return reply.code(401).send({ error: { code: 'invalid_code', message: '访问码不正确' } });
    }
    ctx.loginLimiter.recordSuccess(request.ip);
    const token = ctx.sessions.issue();
    reply.headers({ 'set-cookie': buildSessionCookie(token, ctx.secureCookies) });
    return { ok: true };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (!isSameOrigin(request)) {
      return reply.code(403).send({ error: { code: 'cross_origin_blocked', message: '跨源写请求被拒绝' } });
    }
    const token = sessionTokenFromRequest(request);
    ctx.sessions.revoke(token);
    reply.headers({ 'set-cookie': buildClearedSessionCookie() });
    return { ok: true };
  });

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
      if (!isSameOrigin(request)) {
        return reply.code(403).send({ error: { code: 'cross_origin_blocked', message: '跨源写请求被拒绝' } });
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

