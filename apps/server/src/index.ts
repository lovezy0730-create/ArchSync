import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { loadEnv, isLoopbackHost } from './env.js';
import { discoverProjects } from './projects.js';
import { StateStore } from './store/index.js';
import { rebuildSnapshot, type RebuildResult } from './sync/snapshot.js';
import { WorkspaceWatcher } from './sync/watcher.js';
import { registerRoutes } from './routes.js';
import { PresenceHub, allowedOrigin } from './ws.js';

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
}): Promise<ServerHandle> {
  const root = overrides?.repoRoot ?? repoRoot;
  const env = loadEnv(root);
  const databasePath = overrides?.databasePath ?? join(root, env.databasePath.replace(/^\.?\//, ''));
  const log = (...args: unknown[]) => {
    if (!overrides?.quiet) console.log('[archsync]', ...args);
  };

  const { projects: entries, skipped } = discoverProjects(root);
  for (const reason of skipped) log('跳过项目:', reason);
  if (entries.length === 0) throw new Error('未发现任何有效的 .archsync/project.yaml 项目');

  const store = new StateStore(databasePath);
  await store.load();

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  const hub = new PresenceHub(env.presenceTtlSeconds);
  hub.start();

  // ---- rebuild pipeline: serialized per project, publishes on change ----
  const inFlight = new Map<string, Promise<RebuildResult>>();
  const entryById = new Map(entries.map((e) => [e.id, e]));

  async function runRebuild(entryId: string, jobId: string): Promise<RebuildResult> {
    const entry = entryById.get(entryId);
    if (!entry) throw new Error(`项目不存在: ${entryId}`);
    const previous = inFlight.get(entryId);
    if (previous) await previous.catch(() => undefined);
    const task = rebuildSnapshot(entry, store, env.githubToken, jobId).then((result) => {
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
      if (allowedOrigin(origin, env.host)) cb(null, true);
      else cb(new Error('Origin 不被允许'), false);
    },
  });
  await app.register(websocket);

  app.get('/healthz', async () => ({ ok: true, time: new Date().toISOString() }));

  registerRoutes(app, {
    entries: entryById,
    store,
    devAuthMode: env.devAuthMode,
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
    if (env.devAuthMode !== 'mock' || user.length === 0 || user.length > 64) {
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

  // ---- watcher ----
  const watcher = new WorkspaceWatcher(
    entries,
    { onProjectChanged: (entry) => scheduleRebuild(entry.id) },
    env.watchDebounceMs,
  );
  watcher.start();

  // ---- initial snapshots ----
  await Promise.all(entries.map((e) => runRebuild(e.id, randomUUID()).catch(() => undefined)));

  await app.listen({ port: env.port, host: env.host });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : env.port;
  const displayHost = env.host === '0.0.0.0' || env.host === '::' ? '127.0.0.1' : env.host;
  const url = `http://${displayHost}:${actualPort}`;
  log(`ArchSync 服务已启动 ${url}`);
  if (env.githubToken === null) {
    log('未配置 GITHUB_TOKEN：含演示数据的项目将使用 demo fixtures（界面会标记「演示数据」）');
  }
  if (!isLoopbackHost(env.host)) {
    log('警告：服务绑定在非回环地址；mock 身份模式已被禁用');
  }

  return {
    url,
    close: async () => {
      await watcher.stop();
      await hub.stop();
      await app.close();
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
