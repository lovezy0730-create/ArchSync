import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { createServer } from '../src/index.js';
import { registerRoutes } from '../src/routes.js';
import { SessionStore } from '../src/auth.js';
import { LoginRateLimiter } from '../src/auth-rate-limit.js';
import { emptyProjectState } from '../src/store/index.js';
import { discoverArchitecture } from '../src/architecture/discovery.js';
import type { ProjectEntry } from '../src/projects.js';
import type { ArchitectureResponse } from '@archsync/contracts';

const write = (root: string, path: string, text: string) => {
  const dest = join(root, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
};

/** QQAgent-like structure: MaiBot/Research/Scripts with real package boundaries. */
function makeFixture(root: string): string {
  const repo = join(root, 'repo');
  write(repo, 'MaiBot/__init__.py', '');
  write(repo, 'MaiBot/core/__init__.py', '');
  write(repo, 'MaiBot/core/bot.py', 'from ..handlers.chat import ChatHandler\n\nclass Bot:\n    def __init__(self):\n        self.handler = ChatHandler()\n\n    async def run(self):\n        return await self.handler.handle("hi")\n');
  write(repo, 'MaiBot/handlers/__init__.py', '');
  write(repo, 'MaiBot/handlers/chat.py', 'from ..services.llm import complete\n\nclass ChatHandler:\n    async def handle(self, text):\n        return await complete(text)\n');
  write(repo, 'MaiBot/services/__init__.py', '');
  write(repo, 'MaiBot/services/llm.py', 'async def complete(text):\n    return text\n');
  write(repo, 'MaiBot/webui/package.json', JSON.stringify({ name: '@qqagent/webui', exports: './src/index.ts' }));
  write(repo, 'MaiBot/webui/src/index.ts', "import { fetchModels } from './api';\nexport function boot(): number { return fetchModels(); }\n");
  write(repo, 'MaiBot/webui/src/api.ts', 'export function fetchModels(): number { return 3; }\n');
  write(repo, 'Research/__init__.py', '');
  write(repo, 'Research/analysis/__init__.py', '');
  write(repo, 'Research/analysis/pipeline.py', 'from ..utils.io import load\n\ndef run_pipeline(path):\n    return load(path)\n');
  write(repo, 'Research/utils/__init__.py', '');
  write(repo, 'Research/utils/io.py', 'def load(path):\n    return path\n');
  write(repo, 'Scripts/run.py', 'from MaiBot.core.bot import Bot\n\nif __name__ == "__main__":\n    Bot()\n');
  write(repo, 'Scripts/cleanup.py', 'def cleanup():\n    return 0\n');
  write(repo, 'node_modules/junk/index.js', 'module.exports = 1;\n');
  execFileSync('git', ['init', '-q', repo], { windowsHide: true });
  execFileSync('git', ['-C', repo, 'add', '-A'], { windowsHide: true });
  execFileSync('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture'], { windowsHide: true });
  return repo;
}

afterEach(() => {
  delete process.env.ARCHSYNC_DATA_DIR;
});

describe('structure-first module discovery', () => {
  it('finds package boundaries and systems instead of top-level folder cards', () => {
    const root = mkdtempSync(join(tmpdir(), 'archsync-discovery-'));
    try {
      const repo = makeFixture(root);
      const discovery = discoverArchitecture(repo);
      expect(discovery.systems.map((system) => system.label).sort()).toEqual(['MaiBot', 'Research', 'Scripts']);
      const labels = discovery.modules.map((module) => module.label);
      expect(labels).toContain('@qqagent/webui');
      expect(labels).toContain('MaiBot/core');
      expect(labels).toContain('MaiBot/handlers');
      expect(labels).toContain('MaiBot/services');
      expect(labels).toContain('Research/analysis');
      expect(labels).toContain('Research/utils');
      expect(discovery.unassigned).toEqual([]);
      const webui = discovery.modules.find((module) => module.label === '@qqagent/webui')!;
      expect(webui.confidence).toBe('high');
      expect(webui.files).toContain('MaiBot/webui/src/index.ts');
      expect(webui.evidence.join(' ')).toContain('package.json');
      const core = discovery.modules.find((module) => module.label === 'MaiBot/core')!;
      expect(core.evidence).toContain('__init__.py');
      expect(core.systemId).toBe(discovery.systems.find((system) => system.label === 'MaiBot')!.id);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });
});

describe('unified architecture projection over the real index', () => {
  it('serves snapshot, four graph levels and resync for a repository without YAML', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archsync-architecture-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    process.env.ARCHSYNC_DATA_DIR = dataDir;
    process.env.PORT = '0';
    const repo = makeFixture(root);
    const server = await createServer({ repoRoot: root, quiet: true });
    try {
      const added = await fetch(server.url + '/api/v1/registry/add-local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repo }),
      });
      expect(added.status).toBe(201);
      const { project } = (await added.json()) as { project: { id: string } };

      type IndexShape = { state: string; indexVersion: number; files: { filePath: string; moduleId: string }[] };
      let index: IndexShape | undefined;
      for (let i = 0; i < 300; i++) {
        index = (await (await fetch(server.url + `/api/v1/projects/${project.id}/code-index`)).json()) as IndexShape;
        if (index.state === 'ready') break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      expect(index?.state).toBe('ready');

      const snapshotResponse = await fetch(server.url + `/api/v1/projects/${project.id}/snapshot`);
      expect(snapshotResponse.status).toBe(200);
      const snapshot = (await snapshotResponse.json()) as {
        configOrigin?: string;
        modules: { id: string; label: string; layer: string; systemId?: string; observedFileCount?: number }[];
        edges: { source: string; target: string; kind: string }[];
      };
      expect(snapshot.configOrigin).toBe('inferred');
      expect(snapshot.modules.length).toBeGreaterThanOrEqual(6);
      const byLabel = new Map(snapshot.modules.map((module) => [module.label, module]));
      expect(byLabel.has('MaiBot/core')).toBe(true);
      expect(byLabel.get('MaiBot/core')!.observedFileCount).toBeGreaterThan(0);
      // Real cross-module dependencies from Python imports/calls, not empty.
      expect(snapshot.edges.length).toBeGreaterThan(0);
      expect(snapshot.edges.some((edge) => edge.kind === 'observed')).toBe(true);

      const architecture = async (query: string) =>
        (await (await fetch(server.url + `/api/v1/projects/${project.id}/architecture?${query}`)).json()) as ArchitectureResponse;

      const system = await architecture('level=system');
      expect(system.plannedAvailable).toBe(false);
      expect(system.nodes.some((node) => node.kind === 'system')).toBe(true);
      expect(system.nodes.filter((node) => node.kind === 'module').length).toBeGreaterThanOrEqual(6);
      expect(system.edges.filter((edge) => edge.kind === 'resolved').length).toBeGreaterThan(0);

      const core = byLabel.get('MaiBot/core')!;
      const moduleView = await architecture(`level=module&moduleId=${core.id}`);
      expect(moduleView.nodes.some((node) => node.kind === 'file' && node.filePath === 'MaiBot/core/bot.py')).toBe(true);
      expect(moduleView.edges.length).toBeGreaterThan(0);

      const fileView = await architecture(`level=file&moduleId=${core.id}`);
      expect(fileView.nodes.some((node) => node.kind === 'file' && node.filePath === 'MaiBot/core/bot.py')).toBe(true);
      expect(fileView.edges.some((edge) => edge.kind === 'resolved')).toBe(true);

      const symbolView = await architecture(`level=symbol&filePath=${encodeURIComponent('MaiBot/core/bot.py')}`);
      expect(symbolView.nodes.some((node) => node.label === 'Bot')).toBe(true);
      expect(symbolView.nodes.some((node) => node.kind === 'function')).toBe(true);
      expect(symbolView.edges.length).toBeGreaterThan(0);

      const status = (await (await fetch(server.url + `/api/v1/projects/${project.id}/code-index/status`)).json()) as { indexVersion: number; files: number };
      expect(status.indexVersion).toBeGreaterThan(0);
      expect(status.files).toBeGreaterThan(0);

      // No-YAML resync must not demand .archsync/project.yaml.
      const resync = await fetch(server.url + `/api/v1/registry/${project.id}/resync`, { method: 'POST' });
      expect(resync.status).toBe(202);
      expect(((await resync.json()) as { jobId: string }).jobId).toBeTruthy();
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 60_000);
});

describe('snapshot HTTP contract', () => {
  const entry = {
    id: 'p',
    name: 'P',
    rootDir: '',
    configText: '',
    configBlobSha: '',
    config: {
      schemaVersion: 1,
      project: { id: 'p', name: 'P', github: { owner: '', repo: '', defaultBranch: 'main' }, root: '.' },
      layers: [{ id: 'l', label: 'L', order: 1 }],
      modules: [],
    },
    configWarnings: [],
    views: [],
    defaultViewId: '',
    viewDiagnostics: [],
    demoCollabPath: null,
    demoCollabFetchedAt: null,
  } as unknown as ProjectEntry;

  async function buildApp(store: unknown, waitMs: number) {
    const app = Fastify();
    registerRoutes(app, {
      entries: new Map([[entry.id, entry]]),
      store: store as never,
      authMode: 'mock',
      authCode: null,
      sessions: new SessionStore(),
      loginLimiter: new LoginRateLimiter(),
      secureCookies: false,
      scheduleRebuild: () => 'job-1',
      snapshotWaitMs: waitMs,
    });
    return app;
  }

  it('returns snapshot_pending quickly instead of waiting for a first rebuild', async () => {
    const store = {
      project: () => ({ ...emptyProjectState(), currentSnapshot: null, jobs: {} }),
      mutate: async (fn: (data: unknown) => unknown) => fn({ projects: {} }),
    };
    const app = await buildApp(store, 50);
    try {
      const started = Date.now();
      const response = await app.inject({ method: 'GET', url: '/api/v1/projects/p/snapshot' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({ code: 'snapshot_pending', jobId: 'job-1' });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await app.close();
    }
  });

  it('surfaces the concrete rebuild failure instead of a generic unavailable', async () => {
    const state = emptyProjectState();
    state.jobs['job-1'] = {
      id: 'job-1',
      projectId: 'p',
      state: 'error',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: 'git baseline 失败: fixture',
    };
    const store = {
      project: () => ({ ...state, currentSnapshot: null }),
      mutate: async (fn: (data: unknown) => unknown) => fn({ projects: {} }),
    };
    const app = await buildApp(store, 50);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/projects/p/snapshot' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('snapshot_failed');
      expect(response.json().error.message).toContain('git baseline');
    } finally {
      await app.close();
    }
  });
});
