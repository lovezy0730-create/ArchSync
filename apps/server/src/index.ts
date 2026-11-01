import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { arch, cpus, platform, release, totalmem } from 'node:os';
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
import { projectArchitecture } from './architecture/projection.js';
import { readGitInfo } from './git-info.js';
import { readDiscoveryPreferences, writeDiscoveryPreferences } from './architecture/preferences.js';
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

interface BuildInfo { version: string; sha: string; builtAt: string | null; dirty: boolean | null }
function readBuildInfo(): BuildInfo {
  const raw = process.env.ARCHSYNC_BUILD_INFO;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<BuildInfo>;
      return {
        version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
        sha: typeof parsed.sha === 'string' ? parsed.sha : 'unknown',
        builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null,
        dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : null,
      };
    } catch { /* fall through */ }
  }
  return { version: process.env.ARCHSYNC_APP_VERSION ?? 'unknown', sha: process.env.ARCHSYNC_BUILD_SHA ?? 'unknown', builtAt: null, dirty: null };
}

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
  const localChanges = new Map<string, RebuildResult['overlay']>();
  const codeVersions = new Map<string, number>();
  const codeCounts = new Map<string, { files: number; symbols: number; stale: number }>();
  // Startup is observable: /healthz must answer before any repository scan.
  let closing = false;
  let backgroundScanTimer: ReturnType<typeof setTimeout> | null = null;
  let watcherStartTimer: ReturnType<typeof setTimeout> | null = null;
  const startupStartedAt = Date.now();
  const startup = {
    startedAt: new Date(startupStartedAt).toISOString(),
    phase: 'starting' as 'starting' | 'restoring' | 'listening' | 'background-scan' | 'ready' | 'error',
    listenMs: null as number | null,
    restoredProjects: 0,
    background: { total: 0, completed: 0, failed: 0, running: 0 },
    lastError: null as string | null,
  };

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
  startup.restoredProjects = liveEntries.size;
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

  /**
   * Aggregate the authoritative code index into module-level facts:
   * cross-module dependencies from resolved imports/calls (TS, JS and Python)
   * plus per-module file/symbol counts. Used by the snapshot so the planned
   * view shows real architecture instead of isolated directory cards.
   */
  const observeIndex = (projectId: string) => {
    const files = codeIndex.files(projectId);
    const byUid = new Map<string, { moduleId: string; filePath: string }>();
    for (const file of files) {
      for (const symbol of file.symbols) {
        byUid.set(symbol.symbolUid, { moduleId: file.moduleId, filePath: file.filePath });
      }
    }
    const pairs = new Map<string, { source: string; target: string }>();
    const stats = new Map<string, { files: number; symbols: number }>();
    let symbols = 0;
    let stale = 0;
    let version = 0;
    for (const file of files) {
      symbols += file.symbols.length;
      version += file.revision;
      if (file.status !== 'fresh') stale += 1;
      if (file.status !== 'fresh') continue;
      const stat = stats.get(file.moduleId) ?? { files: 0, symbols: 0 };
      stat.files += 1;
      stat.symbols += file.symbols.length;
      stats.set(file.moduleId, stat);
      for (const relation of file.relations) {
        if (relation.kind !== 'imports' && relation.kind !== 'calls') continue;
        if (relation.strength !== 'resolved' || !relation.targetUid) continue;
        const target = byUid.get(relation.targetUid);
        if (!target || target.filePath === file.filePath) continue;
        if (file.moduleId === target.moduleId) continue;
        if (file.moduleId === '__observed_unplanned__' || target.moduleId === '__observed_unplanned__') continue;
        pairs.set(`${file.moduleId}->${target.moduleId}`, { source: file.moduleId, target: target.moduleId });
      }
    }
    return { dependencies: [...pairs.values()], stats, totals: { files: files.length, symbols, stale, version } };
  };

  async function runRebuild(entryId: string, jobId: string): Promise<RebuildResult> {
    return rebuildQueue.run(entryId, async () => {
      const entry = entryById.get(entryId);
      if (!entry) throw new Error(`项目不存在: ${entryId}`);
      const rebuildStartedAt = Date.now();
      let observation:
        | {
            dependencies: { source: string; target: string }[];
            stats: Map<string, { files: number; symbols: number }>;
            totals: { files: number; symbols: number; stale: number; version: number };
          }
        | undefined;
      if (entry.rootDir) {
        codeStates.set(entryId, { state: 'scanning', error: null, scannedAt: null });
        try {
          const moduleFor = (path: string) => entry.config.modules.find((m) => matchPaths(m.paths, [path]).length > 0)?.id ?? '__observed_unplanned__';
          scanAstIndex(entry.rootDir, entryId, codeIndex, {}, moduleFor);
          const astDoneAt = Date.now();
          await scanPythonIndex(entry.rootDir, entryId, codeIndex, {}, moduleFor);
          const pythonDoneAt = Date.now();
          codeStates.set(entryId, { state: 'ready', error: null, scannedAt: new Date().toISOString() });
          observation = observeIndex(entryId);
          codeVersions.set(entryId, observation.totals.version);
          codeCounts.set(entryId, { files: observation.totals.files, symbols: observation.totals.symbols, stale: observation.totals.stale });
          if (process.env.ARCHSYNC_REBUILD_TIMING) log(`[rebuild] ${entryId} ast=${astDoneAt - rebuildStartedAt}ms python=${pythonDoneAt - astDoneAt}ms deps=${observation.dependencies.length}`);
        } catch (error) {
          codeStates.set(entryId, { state: 'error', error: error instanceof Error ? error.message : '扫描失败', scannedAt: new Date().toISOString() });
        }
      }
      return rebuildSnapshot(entry, store, env.githubToken, jobId, syncCacheReader, observation).then((result) => {
      if (process.env.ARCHSYNC_REBUILD_TIMING) log(`[rebuild] ${entryId} total=${Date.now() - rebuildStartedAt}ms`);
      localChanges.set(entryId, result.overlay ?? null);
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

  /** Coalesce watcher bursts: at most one queued rebuild per project. */
  const pendingRebuilds = new Map<string, string>();
  function scheduleRebuild(entryId: string): string {
    const pending = pendingRebuilds.get(entryId);
    if (pending) return pending;
    const jobId = randomUUID();
    pendingRebuilds.set(entryId, jobId);
    void runRebuild(entryId, jobId)
      .catch((err) => log('重建失败', entryId, err))
      .finally(() => {
        if (pendingRebuilds.get(entryId) === jobId) pendingRebuilds.delete(entryId);
      });
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

  app.get('/healthz', async () => ({
    ok: true,
    instanceId: process.env.ARCHSYNC_INSTANCE_ID ?? null,
    pid: process.pid,
    time: new Date().toISOString(),
    phase: startup.phase,
    startup: { ...startup, uptimeMs: Date.now() - startupStartedAt },
  }));

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
    return { projectId: entry.id, origin: entry.configOrigin ?? 'planned', systems: entry.config.layers, modules,
      ...(codeStates.get(entry.id) ?? { state: entry.rootDir ? 'idle' : 'unavailable', error: null, scannedAt: null }),
      summary, files, changes: localChanges.get(entry.id) ?? null, trustedRelations: codeIndex.trustedRelations(entry.id),
      indexVersion: codeVersions.get(entry.id) ?? files.reduce((total, file) => total + file.revision, 0) };
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/code-index/status', async (request, reply) => {
    const entry = entryById.get(request.params.id);
    if (!entry) return reply.code(404).send({ error: { message: '项目不存在' } });
    const counts = codeCounts.get(entry.id) ?? { files: 0, symbols: 0, stale: 0 };
    return {
      projectId: entry.id,
      ...(codeStates.get(entry.id) ?? { state: entry.rootDir ? 'idle' : 'unavailable', error: null, scannedAt: null }),
      indexVersion: codeVersions.get(entry.id) ?? 0,
      ...counts,
    };
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/git', async (request, reply) => {
    const entry = entryById.get(request.params.id);
    if (!entry) return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
    return reply.headers({ 'cache-control': 'no-store' }).send(await readGitInfo(entry.rootDir));
  });
  app.get<{
    Params: { id: string };
    Querystring: { level?: string; moduleId?: string; filePath?: string; systemId?: string };
  }>('/api/v1/projects/:id/architecture', async (request, reply) => {
    const entry = entryById.get(request.params.id);
    if (!entry) return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
    const parsed = z
      .object({
        level: z.enum(['system', 'module', 'file', 'symbol']),
        moduleId: z.string().max(256).optional(),
        filePath: z.string().max(4096).optional(),
        systemId: z.string().max(256).optional(),
      })
      .safeParse({
        level: request.query.level ?? 'system',
        moduleId: request.query.moduleId,
        filePath: request.query.filePath,
        systemId: request.query.systemId,
      });
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_level', message: 'level 必须是 system/module/file/symbol' } });
    const files = codeIndex.files(entry.id);
    const response = projectArchitecture({
      entry,
      files,
      level: parsed.data.level,
      scope: {
        moduleId: parsed.data.moduleId ?? null,
        filePath: parsed.data.filePath ?? null,
        systemId: parsed.data.systemId ?? null,
      },
      preferences: readDiscoveryPreferences(dataDir, entry.id),
    });
    return reply.headers({ 'cache-control': 'no-store' }).send(response);
  });
  app.get('/api/v1/diagnostics', async () => {
    const build = readBuildInfo();
    let schemaVersion: number | null = null;
    try {
      const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null } | undefined;
      schemaVersion = row?.version ?? null;
    } catch { /* older DB without migrations table */ }
    const projects = [...entryById.values()].map((entry) => ({
      id: entry.id,
      name: entry.name,
      rootDir: entry.rootDir,
      kind: registry.get(entry.id)?.kind ?? null,
      snapshotVersion: store.project(entry.id).currentSnapshot?.version ?? null,
      codeIndex: codeCounts.get(entry.id) ?? null,
      codeState: codeStates.get(entry.id) ?? null,
    }));
    return {
      app: { name: 'ArchSync', ...build },
      agent: {
        version: build.version,
        node: process.version,
        pid: process.pid,
        uptimeMs: Date.now() - startupStartedAt,
        phase: startup.phase,
      },
      database: { path: join(dataDir, 'registry.sqlite'), schemaVersion },
      dataDir,
      logDir: process.env.ARCHSYNC_LOG_DIR ?? null,
      startup: { ...startup, uptimeMs: Date.now() - startupStartedAt },
      projects,
      environment: {
        platform: platform(), release: release(), arch: arch(),
        cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryBytes: totalmem(),
        electron: process.env.ARCHSYNC_ELECTRON_VERSION ?? null,
      },
    };
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/architecture/preferences', async (request, reply) => {
    if (!entryById.has(request.params.id)) return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
    return readDiscoveryPreferences(dataDir, request.params.id);
  });
  app.put<{ Params: { id: string } }>('/api/v1/projects/:id/architecture/preferences', async (request, reply) => {
    if (!isSameOrigin(request)) return reply.code(403).send({ error: { code: 'cross_origin_blocked', message: '跨源写请求被拒绝' } });
    if (!entryById.has(request.params.id)) return reply.code(404).send({ error: { code: 'project_not_found', message: '项目不存在' } });
    const result = writeDiscoveryPreferences(dataDir, request.params.id, request.body);
    if (!result.ok) return reply.code(400).send({ error: { code: 'invalid_preferences', message: result.message } });
    return result.preferences;
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
    snapshotWaitMs: env.snapshotWaitMs,
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
  const sourceDirsFor = (entryId: string): string[] | null => {
    try {
      const files = codeIndex.files(entryId);
      if (files.length === 0) return null;
      const entry = entryById.get(entryId);
      if (!entry?.rootDir) return null;
      const dirs = new Set<string>();
      for (const file of files) {
        if (file.status === 'deleted') continue;
        const absolute = join(entry.rootDir, file.filePath);
        const index = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'));
        dirs.add(index === -1 ? absolute : absolute.slice(0, index));
      }
      return [...dirs];
    } catch {
      return null;
    }
  };
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
      },
      sourceDirs: sourceDirsFor,
    },

    env.watchDebounceMs,
  );
  const monitorPaused = process.env.ARCHSYNC_MONITOR_PAUSED === '1';
  if (monitorPaused) {
    log('监控已暂停（ARCHSYNC_MONITOR_PAUSED）——文件监听未启动');
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
        },
        sourceDirs: sourceDirsFor,
      },
      env.watchDebounceMs,
    );
    if (!monitorPaused) watcher.start();
    log(`文件监听已重建（${liveEntries.size} 个项目）`);
  });

  // ---- GitHub sync worker (阶段 B): budgeted polling with ETag cache ----
  const syncClient = new GithubApiClient(db, () => env.githubToken);
  const syncCacheReader = {
    readCache: <T>(projectId: string, kind: string): T | null => syncClient.readCache<T>(projectId, kind),
    cacheUpdatedAt: (projectId: string): string | null => syncClient.cacheUpdatedAt(projectId),
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

  // ---- listen first, scan later ----
  // A registered large repository must never delay the HTTP server (and thus
  // the desktop window): the persisted snapshot/index are served immediately,
  // and full rebuilds run in the background with bounded concurrency.
  startup.phase = 'listening';
  await app.listen({ port: env.port, host: env.host });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : env.port;
  const displayHost = env.host === '0.0.0.0' || env.host === '::' ? '127.0.0.1' : env.host;
  const url = `http://${displayHost}:${actualPort}`;
  startup.listenMs = Date.now() - startupStartedAt;
  log(`ArchSync 服务已启动 ${url}（listen ${startup.listenMs}ms，${startup.restoredProjects} 个项目）`);
  // Start watching after the server is reachable: source-aware watch targets
  // come from the restored index, and a large repository's initial walk must
  // not delay the window or the first background rebuild.
  if (!monitorPaused) {
    watcherStartTimer = setTimeout(() => {
      watcherStartTimer = null;
      if (!closing) watcher.start();
    }, 3500);
    watcherStartTimer.unref?.();
  }
  log(`鉴权模式: ${env.authMode}${env.authMode === 'code' ? '（访问码）' : env.authMode === 'mock' ? '（演示，仅限本机）' : '（无鉴权，仅限本机）'}`);

  // Prefer the project the user last opened, then everything else.
  const readActiveProjectId = (): string | null => {
    try {
      const row = db.prepare('SELECT payload_json FROM workspace_preferences WHERE project_id=?').get('@active-project') as
        | { payload_json: string }
        | undefined;
      const parsed = row ? z.object({ projectId: z.string().max(256) }).safeParse(JSON.parse(row.payload_json)) : null;
      return parsed?.success ? parsed.data.projectId : null;
    } catch {
      return null;
    }
  };
  const orderedRebuildIds = (() => {
    const active = readActiveProjectId();
    const ids = [...new Set([...(active ? [active] : []), ...entries.map((entry) => entry.id)])];
    return ids.filter((id) => entryById.has(id));
  })();
  startup.background.total = orderedRebuildIds.length;
  startup.phase = orderedRebuildIds.length > 0 ? 'background-scan' : 'ready';
  const runBackgroundScans = async () => {
    const concurrency = Math.max(1, Math.min(Number(process.env.ARCHSYNC_STARTUP_CONCURRENCY ?? 2), 4));
    let cursor = 0;
    const worker = async () => {
      while (!closing && cursor < orderedRebuildIds.length) {
        const id = orderedRebuildIds[cursor++]!;
        startup.background.running += 1;
        const started = Date.now();
        try {
          // Old persisted indexes may use module ids from a previous
          // discovery strategy. Re-map them by path first so the code view is
          // usable immediately; the rebuild below writes canonical values.
          const entry = entryById.get(id);
          if (entry?.rootDir) {
            const moduleFor = (path: string) => entry.config.modules.find((module) => matchPaths(module.paths, [path]).length > 0)?.id ?? '__observed_unplanned__';
            const reassigned = codeIndex.reassignModules(id, moduleFor);
            if (reassigned > 0) {
              codeVersions.set(id, (codeVersions.get(id) ?? 0) + reassigned);
              log(`[startup] 重映射 ${id} 的 ${reassigned} 个文件到当前模块`);
            }
          }
          await runRebuild(id, randomUUID());
          startup.background.completed += 1;
          log(`[startup] 后台重建完成 ${id}（${Date.now() - started}ms）`);
        } catch (error) {
          startup.background.failed += 1;
          startup.lastError = `${id}: ${(error as Error).message}`;
          log(`[startup] 后台重建失败 ${id}: ${(error as Error).message}`);
        } finally {
          startup.background.running -= 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, orderedRebuildIds.length) }, worker));
    startup.phase = 'ready';
    log(`[startup] 后台扫描结束（总耗时 ${Date.now() - startupStartedAt}ms，失败 ${startup.background.failed}）`);
  };
  // Let the window connect to /healthz first: a large synchronous AST scan
  // would otherwise block the event loop and make startup look slow.
  backgroundScanTimer = setTimeout(() => {
    backgroundScanTimer = null;
    if (closing) return;
    void runBackgroundScans().catch((error) => {
      startup.phase = 'error';
      startup.lastError = (error as Error).message;
      log('[startup] 后台扫描异常', (error as Error).message);
    });
  }, Number(process.env.ARCHSYNC_STARTUP_DELAY_MS ?? 2000));
  backgroundScanTimer.unref?.();
  if (env.githubToken === null) {
    log('未配置 GITHUB_TOKEN：含演示数据的项目将使用 demo fixtures（界面会标记「演示数据」）');
  }
  if (!isLoopbackHost(env.host)) {
    log(`服务绑定在非回环地址 ${env.host} —— 局域网/服务器部署请使用 HTTPS 反向代理（见 docs/deploy.md）`);
  }

  return {
    url,
    close: async () => {
      closing = true;
      if (backgroundScanTimer) { clearTimeout(backgroundScanTimer); backgroundScanTimer = null; }
      if (watcherStartTimer) { clearTimeout(watcherStartTimer); watcherStartTimer = null; }
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
