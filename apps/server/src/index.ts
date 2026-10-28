import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { loadEnv, isLoopbackHost, type AuthMode } from './env.js';
import { discoverProjects, loadProjectEntry } from './projects.js';
import { LocalDatabase } from './db.js';
import { ProjectRegistry } from './registry.js';
import { StateStore } from './store/index.js';
import { rebuildSnapshot, type RebuildResult } from './sync/snapshot.js';
import { WorkspaceWatcher } from './sync/watcher.js';
import { GithubSyncWorker } from './sync/github-worker.js';
import { GithubApiClient } from './sync/github-client.js';
import { registerRoutes } from './routes.js';
import { registerRegistryRoutes } from './registry-routes.js';
import { PresenceHub, allowedOrigin } from './ws.js';
import { SessionStore, parseCookies, SESSION_COOKIE, sessionTokenFromRequest } from './auth.js';
import { LoginRateLimiter } from './auth-rate-limit.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

export interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

/** Re-read a registered external project from disk; null when unloadable. */
function loadExternalEntry(registered: {
  id: string;
  localPath: string;
}): import('./projects.js').ProjectEntry | null {
  const entry = loadProjectEntry(join(registered.localPath, '.archsync', 'project.yaml'));
  return 'error' in entry ? null : entry;
}

/** Forward declarations wired after construction (watcher re-hook). */
const dynamicRefs: { rewatch?: () => Promise<void> } = {};

export async function createServer(overrides?: {
  repoRoot?: string;
  databasePath?: string;
  quiet?: boolean;
  authMode?: AuthMode;
  authCode?: string | null;
  port?: number;
}): Promise<ServerHandle> {
  const root = overrides?.repoRoot ?? repoRoot;
  const env = overrides?.authMode || overrides?.authCode !== undefined
    ? { ...loadEnv(root), ...(overrides.authMode ? { authMode: overrides.authMode } : {}), ...(overrides.authCode !== undefined ? { authCode: overrides.authCode } : {}), ...(overrides.port ? { port: overrides.port } : {}) }
    : loadEnv(root);
  const databasePath = overrides?.databasePath ?? join(root, env.databasePath.replace(/^\.?\//, ''));
  const log = (...args: unknown[]) => {
    if (!overrides?.quiet) console.log('[archsync]', ...args);
  };

  // Projects are discovered from WORKSPACE_ROOT (deployment mount point) or
  // the repository root itself; code/dist always resolve from `root`.
  const workspaceRoot = process.env.WORKSPACE_ROOT
    ? resolve(process.env.WORKSPACE_ROOT)
    : root;
  if (workspaceRoot !== root) {
    log(`项目发现目录: ${workspaceRoot} (WORKSPACE_ROOT)`);
  }
  const { projects: discovered, skipped } = discoverProjects(workspaceRoot);

  const store = new StateStore(databasePath);
  await store.load();
  const db = new LocalDatabase(join(root, '.local', 'registry.sqlite'));

  // Registry seeds built-in projects idempotently, then any previously
  // registered external repos are reloaded from disk and merged into the
  // live entry map that routes/watcher/snapshot share by reference.
  const liveEntries = new Map(discovered.map((e) => [e.id, e]));
  const registry = new ProjectRegistry(db, liveEntries, (event) => {
    log(`注册表变更: ${event}（运行时已同步）`);
    void dynamicRefs.rewatch?.();
  });
  const seedLog = (...a: unknown[]) => log(...a);
  registry.seedFromDiscovery(discovered, skipped, seedLog);
  let externalCount = 0;
  for (const registered of registry.list()) {
    if (liveEntries.has(registered.id)) continue;
    const entry = loadExternalEntry(registered);
    if (entry) {
      liveEntries.set(registered.id, entry);
      externalCount += 1;
    } else {
      log(`外部项目加载失败（保留注册）: ${registered.id} @ ${registered.localPath}`);
    }
  }
  if (externalCount > 0) log(`已恢复 ${externalCount} 个外部注册项目`);
  const entries = discovered; // builtin entries remain the bootstrap set

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  const hub = new PresenceHub(env.presenceTtlSeconds);
  hub.start();
  const sessions = new SessionStore();
  const loginLimiter = new LoginRateLimiter();
  const sessionSweeper = setInterval(() => sessions.sweep(), 10 * 60_000);

  // ---- rebuild pipeline: serialized per project, publishes on change ----
  const inFlight = new Map<string, Promise<RebuildResult>>();
  // liveEntries is shared by reference with the registry: dynamic add/remove
  // takes effect in routes immediately, no restart needed.
  const entryById = liveEntries;

  async function runRebuild(entryId: string, jobId: string): Promise<RebuildResult> {
    const entry = entryById.get(entryId);
    if (!entry) throw new Error(`项目不存在: ${entryId}`);
    const previous = inFlight.get(entryId);
    if (previous) await previous.catch(() => undefined);
    const task = rebuildSnapshot(entry, store, env.githubToken, jobId, syncCacheReader).then((result) => {
      registry.markScan(
        entryId,
        result.snapshot?.version ?? 0,
        result.error ?? null,
      );
      if (result.changed && result.snapshot) {
        hub.publishSnapshot(entryId, result.snapshot.id, result.snapshot.version);
        log(`快照已发布 ${entry.name} v${result.snapshot.version}`);
      }
      return result;
    });
    inFlight.set(entryId, task);
    try {
      return await task;
    } finally {
      inFlight.delete(entryId);
    }
  }

  function scheduleRebuild(entryId: string): string {
    const jobId = randomUUID();
    void runRebuild(entryId, jobId).catch((err) => log('重建失败', entryId, err));
    return jobId;
  }

  // ---- plugins ----
  await app.register(cors, {
    origin: (origin, cb) => {
      // disallowed origins get NO CORS headers (browser blocks the response);
      // we must not throw here — that surfaces as a 500. Writes from
      // disallowed origins are additionally rejected by isSameOrigin.
      if (allowedOrigin(origin, env.host)) cb(null, true);
      else cb(null, false);
    },
  });
  await app.register(websocket);

  app.get('/healthz', async () => ({ ok: true, time: new Date().toISOString() }));

  // ---- unified auth gate (code mode) -------------------------------------
  // Every /api/v1/* request — reads included — requires a valid session.
  // Only the auth endpoints themselves and /healthz stay reachable so the
  // login page can bootstrap. This closes the gap where GET endpoints
  // (projects/snapshot/team/jobs) leaked data anonymously in code mode.
  const PUBLIC_API_PATHS = new Set([
    '/api/v1/me',
    '/api/v1/auth/login',
    '/api/v1/auth/logout',
  ]);
  if (env.authMode === 'code') {
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0] ?? request.url;
      if (!path.startsWith('/api/') || PUBLIC_API_PATHS.has(path)) return;
      const token = sessionTokenFromRequest(request);
      if (!sessions.validate(token)) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: '需要访问码会话（请先登录）' },
        });
      }
    });
  }

  registerRegistryRoutes(app, {
    registry,
    db,
    scheduleRebuild: (entryId: string) => scheduleRebuild(entryId),
    listEntries: () => [...liveEntries.values()],
    syncGithubNow: async (entryId) => {
      const entry = liveEntries.get(entryId);
      if (!entry) return { state: 'skipped' as const, events: 0, errors: ['项目不存在'] };
      // 连续点击合并：worker.syncNow 内部串行，重复调用排队等待上一轮完成
      const summary = await syncWorker.syncNow(entry);
      if (summary.changed && summary.events.length > 0) {
        registry.markSync(entryId, null);
        scheduleRebuild(entryId); // rebuild + WS 推送由 runRebuild 处理
      }
      const rateLimited = summary.errors.some((e) => e.includes('限流') || e.includes('预算'));
      return {
        state: rateLimited
          ? ('rate_limited' as const)
          : summary.errors.length > 0
            ? ('failed' as const)
            : summary.changed
              ? ('completed' as const)
              : ('completed_no_change' as const),
        events: summary.events.length,
        errors: summary.errors,
      };
    },
  });

  registerRoutes(app, {
    entries: entryById,
    store,
    authMode: env.authMode,
    authCode: env.authCode,
    sessions,
    loginLimiter,
    secureCookies: env.nodeEnv === 'production',
    scheduleRebuild: (entry) => scheduleRebuild(entry.id),
    scheduleRebuildAndWait: async (entry) => {
      const jobId = randomUUID();
      await runRebuild(entry.id, jobId).catch(() => undefined);
      return { jobId };
    },
  });

  // ---- presence websocket ----
  app.get('/ws', { websocket: true }, (socket, request) => {
    const projectId = (request.query as { projectId?: string }).projectId ?? '';
    const user = ((request.query as { user?: string }).user ?? '').trim();
    if (!entryById.has(projectId)) {
      socket.close(4004, 'project_not_found');
      return;
    }
    // display name is a per-connection label; authentication depends on mode
    const nameOk = user.length > 0 && user.length <= 64;
    let authed = false;
    if (env.authMode === 'code') {
      const cookies = parseCookies(request.headers.cookie);
      authed = sessions.validate(cookies[SESSION_COOKIE]);
    } else if (env.authMode === 'mock') {
      authed = true; // loopback dev demo only (enforced by env validation)
    }
    if (!nameOk || !authed) {
      socket.close(4003, 'unauthorized');
      return;
    }
    if (!allowedOrigin(request.headers.origin, env.host)) {
      socket.close(4003, 'origin_not_allowed');
      return;
    }
    hub.handleConnection(socket, projectId, user);
  });

  // ---- static web dist (production-style single-port mode) ----
  const distDir = join(root, 'apps', 'web', 'dist');
  if (existsSync(join(distDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: distDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
      return reply.sendFile('index.html');
    });
    log('已启用内置前端静态服务 (apps/web/dist)');
  }

  // ---- watcher (dynamic: rebuilt when the registry changes; config reload on edit) ----
  const watchRoots = [...new Set([...liveEntries.values()].map((e) => e.rootDir))];
  log(`文件监听启动: ${liveEntries.size} 个项目 / ${watchRoots.length} 个根`);
  let watcher = new WorkspaceWatcher(
    [...liveEntries.values()],
    { onProjectChanged: (entry) => {
        // project.yaml/views 变更时热重载配置；失败保留上一份有效配置
        const reloaded = loadProjectEntry(join(entry.rootDir, '.archsync', 'project.yaml'));
        if ('error' in reloaded) {
          log(`项目重载失败，保留上一份有效配置: ${reloaded.error}`);
          return;
        }
        liveEntries.set(reloaded.id, reloaded);
        scheduleRebuild(reloaded.id);
      } },

    env.watchDebounceMs,
  );
  watcher.start();
  dynamicRefs.rewatch = async () => {
    await watcher.stop();
    watcher = new WorkspaceWatcher(
      [...liveEntries.values()],
      { onProjectChanged: (entry) => scheduleRebuild(entry.id) },
      env.watchDebounceMs,
    );
    watcher.start();
    log(`文件监听已重建（${liveEntries.size} 个项目）`);
  };

  // ---- GitHub sync worker (阶段 B): budgeted polling with ETag cache ----
  const syncClient = new GithubApiClient(db, () => env.githubToken);
  const syncCacheReader = {
    readCache: <T>(projectId: string, kind: string): T | null => syncClient.readCache<T>(projectId, kind),
  };
  const syncWorker = new GithubSyncWorker(
    db,
    syncClient,
    () => registry.monitoredEntries(),
    {
      onRemoteChanged: (entry) => {
        registry.markSync(entry.id, null);
        scheduleRebuild(entry.id);
      },
      log,
    },
  );
  syncWorker.start();
  log(`GitHub 同步引擎已启动（${env.githubToken ? '授权模式 4800/h' : '匿名模式 55/h'}）`);

  // ---- initial snapshots ----
  await Promise.all(entries.map((e) => runRebuild(e.id, randomUUID()).catch(() => undefined)));

  await app.listen({ port: env.port, host: env.host });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : env.port;
  const displayHost = env.host === '0.0.0.0' || env.host === '::' ? '127.0.0.1' : env.host;
  const url = `http://${displayHost}:${actualPort}`;
  log(`ArchSync 服务已启动 ${url}`);
  log(`鉴权模式: ${env.authMode}${env.authMode === 'code' ? '（访问码）' : env.authMode === 'mock' ? '（演示，仅限本机）' : '（无鉴权，仅限本机）'}`);
  if (env.githubToken === null) {
    log('未配置 GITHUB_TOKEN：含演示数据的项目将使用 demo fixtures（界面会标记「演示数据」）');
  }
  if (!isLoopbackHost(env.host)) {
    log(`服务绑定在非回环地址 ${env.host} —— 局域网/服务器部署请使用 HTTPS 反向代理（见 docs/deploy.md）`);
  }

  return {
    url,
    close: async () => {
      clearInterval(sessionSweeper);
      await syncWorker.stop();
      await watcher.stop();
      await hub.stop();
      await app.close();
      db.close();
    },
  };
}

// Direct execution (pnpm start / tsx apps/server/src/index.ts)
if (process.argv[1] && existsSync(process.argv[1]) &&
    process.argv[1].replace(/\\/g, '/').endsWith('apps/server/src/index.ts')) {
  createServer().catch((err) => {
    console.error('[archsync] 启动失败:', err.message);
    process.exit(1);
  });
}
