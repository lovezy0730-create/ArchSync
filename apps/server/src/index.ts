import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { matchPaths } from '@archsync/scanner';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { loadEnv, isLoopbackHost, type AuthMode } from './env.js';
import { discoverProjects } from './projects.js';
import { LocalDatabase } from './db.js';
import { ProjectRegistry } from './registry.js';
import { StateStore } from './store/index.js';
import { rebuildSnapshot, type RebuildResult } from './sync/snapshot.js';
import { WorkspaceWatcher } from './sync/watcher.js';
import { ProjectQueue } from './sync/project-queue.js';
import { CodeIndex } from './code-index.js';
import { scanAstIndex } from './ast-index.js';
import { scanPythonIndex, releasePythonIndex } from './python-index.js';
import { GithubSyncWorker } from './sync/github-worker.js';
import { GithubApiClient } from './sync/github-client.js';
import { isSameOrigin, registerRoutes } from './routes.js';
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

export async function createServer(overrides?: {
  repoRoot?: string;
  databasePath?: string;
  quiet?: boolean;
  authMode?: AuthMode;
  authCode?: string | null;
  port?: number;
}): Promise<ServerHandle> {
  const dynamicRefs: { rewatch?: () => Promise<void> } = {};
  const root = overrides?.repoRoot ?? repoRoot;
  const env = overrides?.authMode || overrides?.authCode !== undefined
    ? { ...loadEnv(root), ...(overrides.authMode ? { authMode: overrides.authMode } : {}), ...(overrides.authCode !== undefined ? { authCode: overrides.authCode } : {}), ...(overrides.port ? { port: overrides.port } : {}) }
    : loadEnv(root);
  // 打包桌面模式：ARCHSYNC_DATA_DIR 重定向可写数据，ARCHSYNC_WEB_DIST 重定向静态资源
  const dataDir = process.env.ARCHSYNC_DATA_DIR
    ? resolve(process.env.ARCHSYNC_DATA_DIR)
    : root;
  const webDist = process.env.ARCHSYNC_WEB_DIST
    ? resolve(process.env.ARCHSYNC_WEB_DIST)
    : join(root, 'apps', 'web', 'dist');
  const databasePath = overrides?.databasePath
    ?? (dataDir !== root
      ? join(dataDir, 'archsync-state.json')
      : join(root, env.databasePath.replace(/^\.?\//, '')));
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
  const db = new LocalDatabase(join(dataDir, 'registry.sqlite'));
  const codeIndex = new CodeIndex(db);
  const codeStates = new Map<string, { state: 'scanning' | 'ready' | 'error'; error: string | null; scannedAt: string | null }>();

  // Registry seeds built-in projects idempotently, then any previously
  // registered external repos are reloaded from disk and merged into the
  // live entry map that routes/watcher/snapshot share by reference.
  const liveEntries = new Map(discovered.map((e) => [e.id, e]));
  const registry = new ProjectRegistry(db, liveEntries, (event) => {
    log(`注册表变更: ${event}（运行时已同步）`);
    void dynamicRefs.rewatch?.();
  }, () => env.githubToken);
  const seedLog = (...a: unknown[]) => log(...a);
  registry.seedFromDiscovery(discovered, skipped, seedLog);
  let externalCount = 0;
  for (const registered of registry.list()) {
    if (liveEntries.has(registered.id)) continue;
    const entry = registry.reloadProjectEntry(registered.id);
    if (entry) {
      liveEntries.set(registered.id, entry);
      externalCount += 1;
    } else {
      log(`外部项目加载失败（保留注册）: ${registered.id} @ ${registered.localPath}`);
    }
  }
  if (externalCount > 0) log(`已恢复 ${externalCount} 个外部注册项目`);
  const entries = [...liveEntries.values()]; // builtin entries remain the bootstrap set

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  const hub = new PresenceHub(env.presenceTtlSeconds);
  hub.start();
  const sessions = new SessionStore();
  const loginLimiter = new LoginRateLimiter();
  const sessionSweeper = setInterval(() => sessions.sweep(), 10 * 60_000);

  // ---- rebuild pipeline: serialized per project, publishes on change ----
  const rebuildQueue = new ProjectQueue();
  const rewatchQueue = new ProjectQueue();
  // liveEntries is shared by reference with the registry: dynamic add/remove
  // takes effect in routes immediately, no restart needed.
  const entryById = liveEntries;

  async function runRebuild(entryId: string, jobId: string): Promise<RebuildResult> {
    return rebuildQueue.run(entryId, async () => {
      const entry = entryById.get(entryId);
      if (!entry) throw new Error(`项目不存在: ${entryId}`);
      if (entry.rootDir) {
        codeStates.set(entryId, { state: 'scanning', error: null, scannedAt: null });
        try {
          const moduleFor = (path: string) => entry.config.modules.find((m) => matchPaths(m.paths, [path]).length > 0)?.id ?? '__observed_unplanned__';
          scanAstIndex(entry.rootDir, entryId, codeIndex, {}, moduleFor);
          await scanPythonIndex(entry.rootDir, entryId, codeIndex, {}, moduleFor);
          codeStates.set(entryId, { state: 'ready', error: null, scannedAt: new Date().toISOString() });
        } catch (error) {
          codeStates.set(entryId, { state: 'error', error: error instanceof Error ? error.message : '扫描失败', scannedAt: new Date().toISOString() });
        }
      }
      return rebuildSnapshot(entry, store, env.githubToken, jobId, syncCacheReader).then((result) => {
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
    });
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

  app.get('/healthz', async () => ({ ok: true, instanceId:process.env.ARCHSYNC_INSTANCE_ID ?? null, pid:process.pid, time: new Date().toISOString() }));

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
      registry.markSync(entryId, summary.errors.length ? summary.errors.join('; ') : null);
      if (summary.changed || summary.errors.length > 0) {
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

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/code-index', async (request, reply) => {
    const entry = entryById.get(request.params.id);
    if (!entry) return reply.code(404).send({ error: { message: '项目不存在' } });
    const files = codeIndex.files(entry.id);
    const summary = { fresh: 0, partial: 0, stale: 0, unsupported: 0, unavailable: 0, deleted: 0, freshSymbols: 0, historicalSymbols: 0 };
    for (const file of files) {
      summary[file.status]++;
      if (file.status === 'fresh') summary.freshSymbols += file.symbols.length;
      else if (file.status === 'stale' || file.status === 'unavailable') summary.historicalSymbols += file.symbols.length;
    }
    const modules = files.some((file) => file.status !== 'deleted' && file.moduleId === '__observed_unplanned__')
      ? [...entry.config.modules, { id: '__observed_unplanned__', label: '未规划的实际代码' }]
      : entry.config.modules;
    return { projectId: entry.id, origin: entry.configOrigin ?? 'planned', modules,
      ...(codeStates.get(entry.id) ?? { state: entry.rootDir ? 'idle' : 'unavailable', error: null, scannedAt: null }),
      summary, files, trustedRelations: codeIndex.trustedRelations(entry.id) };
  });
  const selectionSchema = z.object({ moduleId: z.string().max(256).nullable(), filePath: z.string().max(4096).nullable(), symbolUid: z.string().max(256).nullable() }).strict();
  app.get('/api/v1/workspace/active-project', async () => {
    const row = db.prepare('SELECT payload_json FROM workspace_preferences WHERE project_id=?').get('@active-project') as { payload_json: string } | undefined;
    const parsed = row ? z.object({ projectId: z.string().max(256).nullable() }).safeParse(JSON.parse(row.payload_json)) : null;
    return parsed?.success ? parsed.data : { projectId: null };
  });
  app.put('/api/v1/workspace/active-project', async (request, reply) => {
    if (!isSameOrigin(request)) return reply.code(403).send({ error: { message: '跨源写请求被拒绝' } });
    const parsed = z.object({ projectId: z.string().max(256) }).strict().safeParse(request.body);
    if (!parsed.success || !registry.get(parsed.data.projectId)) return reply.code(400).send({ error: { message: '项目不存在' } });
    db.prepare('INSERT INTO workspace_preferences VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET payload_json=excluded.payload_json').run('@active-project', JSON.stringify(parsed.data));
    return parsed.data;
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/workspace', async (request, reply) => {
    if (!entryById.has(request.params.id)) return reply.code(404).send({ error: { message: '项目不存在' } });
    const row = db.prepare('SELECT payload_json FROM workspace_preferences WHERE project_id=?').get(request.params.id) as { payload_json: string } | undefined;
    const parsed = row ? selectionSchema.safeParse(JSON.parse(row.payload_json)) : null;
    return parsed?.success ? parsed.data : { moduleId: null, filePath: null, symbolUid: null };
  });
  app.put<{ Params: { id: string } }>('/api/v1/projects/:id/workspace', async (request, reply) => {
    if (!isSameOrigin(request)) return reply.code(403).send({ error: { message: '跨源写请求被拒绝' } });
    if (!entryById.has(request.params.id)) return reply.code(404).send({ error: { message: '项目不存在' } });
    const parsed = selectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { message: '工作台状态无效' } });
    db.prepare('INSERT INTO workspace_preferences VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET payload_json=excluded.payload_json').run(request.params.id, JSON.stringify(parsed.data));
    return parsed.data;
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/v1/projects/:id/source', async (request, reply) => {
    const entry = entryById.get(request.params.id);
    const filePath = request.query.path;
    const file = entry && filePath ? codeIndex.get(entry.id, filePath) : null;
    if (!entry?.rootDir || !file || file.status === 'deleted') return reply.code(404).send({ error: { message: '索引文件不存在' } });
    try {
      const rootPath = realpathSync(entry.rootDir);
      const sourcePath = realpathSync(join(rootPath, file.filePath));
      const rel = relative(rootPath, sourcePath);
      if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
        return reply.code(403).send({ error: { message: '文件不在项目目录内' } });
      if (statSync(sourcePath).size > 1024 * 1024) return reply.code(413).send({ error: { message: '文件超过读取限制' } });
      const content = readFileSync(sourcePath, 'utf8');
      const contentHash = createHash('sha256').update(content).digest('hex');
      return { path: file.filePath, content, contentHash, indexedContentMatches: file.status === 'fresh' && contentHash === file.lastSuccessfulHash, status: file.status };
    } catch {
      return reply.code(404).send({ error: { message: '文件不可读取' } });
    }
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
  const distDir = webDist;
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
  const watchedEntries = () => registry.monitoredEntries().map(p => p.entry).filter(e => e.rootDir);
  const watchRoots = [...new Set([...liveEntries.values()].map((e) => e.rootDir))];
  log(`文件监听启动: ${liveEntries.size} 个项目 / ${watchRoots.length} 个根`);
  let watcher = new WorkspaceWatcher(
    watchedEntries(),
    { onProjectChanged: (entry) => {
        // project.yaml/views 变更时热重载配置；失败保留上一份有效配置
        const reloaded = registry.reloadProjectEntry(entry.id);
        if (!reloaded) {
          log(`项目重载失败，保留上一份有效配置: ${entry.id}`);
          return;
        }
        liveEntries.set(reloaded.id, reloaded);
        scheduleRebuild(reloaded.id);
      } },

    env.watchDebounceMs,
  );
  const monitorPaused = process.env.ARCHSYNC_MONITOR_PAUSED === '1';
  if (monitorPaused) {
    log('监控已暂停（ARCHSYNC_MONITOR_PAUSED）——文件监听未启动');
  } else {
    watcher.start();
  }
  dynamicRefs.rewatch = () => rewatchQueue.run('watcher', async () => {
    await watcher.stop();
    watcher = new WorkspaceWatcher(
      watchedEntries(),
      { onProjectChanged: (entry) => {
          const reloaded = registry.reloadProjectEntry(entry.id);
          if (!reloaded) {
            log(`项目重载失败，保留上一份有效配置: ${entry.id}`);
            return;
          }
          liveEntries.set(reloaded.id, reloaded);
          scheduleRebuild(reloaded.id);
        } },
      env.watchDebounceMs,
    );
    if (!monitorPaused) watcher.start();
    log(`文件监听已重建（${liveEntries.size} 个项目）`);
  });

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
        scheduleRebuild(entry.id);
      },
      onSyncFinished: (entry, errors) => registry.markSync(entry.id, errors.length ? errors.join('; ') : null),
      log,
    },
  );
  if (process.env.ARCHSYNC_MONITOR_PAUSED !== '1') {
    syncWorker.start();
  }
  log(`GitHub 同步引擎${process.env.ARCHSYNC_MONITOR_PAUSED === '1' ? '已暂停' : '已启动'}（${env.githubToken ? '授权模式 4800/h' : '匿名模式 55/h'}）`);

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
      dynamicRefs.rewatch = undefined;
      await rewatchQueue.drain();
      await watcher.stop();
      await rebuildQueue.drain();
      releasePythonIndex(codeIndex);
      await hub.stop();
      await app.close();
      db.close();
    },
  };
}

// Direct execution (pnpm start / tsx / bundled desktop agent.cjs).
// The bundled agent sets ARCHSYNC_AGENT_ENTRY=1 via esbuild define.
const bundledEntry = process.env.ARCHSYNC_AGENT_ENTRY === '1';
const tsxEntry = process.argv[1] !== undefined && existsSync(process.argv[1]) &&
    process.argv[1].replace(/\\/g, '/').endsWith('apps/server/src/index.ts');
if (bundledEntry || tsxEntry) {
  createServer().catch((err) => {
    console.error('[archsync] 启动失败:', err.message);
    process.exit(1);
  });
}
