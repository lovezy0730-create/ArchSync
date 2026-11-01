import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from '../src/index.js';
import { StateStore } from '../src/store/index.js';
import { buildSnapshot } from '@archsync/graph';
import { CollabDataSchema, type ProjectConfigFile, type ScanResult } from '@archsync/contracts';

const write = (root: string, path: string, text: string) => {
  const dest = join(root, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
};

function makeRepo(root: string, files = 40): string {
  const repo = join(root, 'repo');
  for (let i = 0; i < files; i++) {
    write(repo, `src/pkg${Math.floor(i / 10)}/f${i}.ts`, `export function fn${i}(n: number): number { return n + ${i}; }\n`);
  }
  execFileSync('git', ['init', '-q', repo], { windowsHide: true });
  execFileSync('git', ['-C', repo, 'add', '-A'], { windowsHide: true });
  execFileSync('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture'], { windowsHide: true });
  return repo;
}

const config: ProjectConfigFile = {
  schemaVersion: 1,
  project: { id: 'p', name: 'P', github: { owner: '', repo: '', defaultBranch: 'main' }, root: '.' },
  layers: [{ id: 'layer-1', label: 'L', order: 1 }],
  modules: [{ id: 'module-1', label: 'M', layer: 'layer-1', description: '', owners: [], paths: ['src/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } }],
};
const scan: ScanResult = {
  ok: true, baselineSha: 'a'.repeat(40), branch: 'main', baselineFiles: ['src/a.ts'], workspaceFiles: ['src/a.ts'], overlay: [],
  modules: [{ moduleId: 'module-1', matchedBaselinePaths: ['src/a.ts'], matchedWorkspacePaths: ['src/a.ts'], overlayChanges: [], overlappedWith: [] }],
  errors: [], scannedAt: new Date().toISOString(), importAnalysisRan: true, observedDependencies: [],
};
const validSnapshot = buildSnapshot({
  config, configWarnings: [], configBlobSha: 'sha', scan,
  collab: CollabDataSchema.parse({ source: 'unavailable', demo: false, fetchedAt: new Date().toISOString(), error: null }),
  version: 4, snapshotId: 'snap-p-4', now: new Date().toISOString(),
});

afterEach(() => {
  delete process.env.ARCHSYNC_DATA_DIR;
  delete process.env.WORKSPACE_ROOT;
  delete process.env.PORT;
});

describe('old user data upgrade', () => {
  it('resets jobs left running and keeps a compatible snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archsync-upgrade-state-'));
    try {
      const statePath = join(root, 'state.json');
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        projects: {
          p: {
            nextVersion: 5,
            currentSnapshot: validSnapshot,
            lastContentHash: validSnapshot.contentHash,
            annotations: {},
            annotationRevisions: [],
            jobs: {
              'job-old': { id: 'job-old', projectId: 'p', state: 'running', createdAt: '2026-10-01T00:00:00Z', finishedAt: null, error: null },
            },
          },
        },
      }, null, 2));
      const store = new StateStore(statePath);
      await store.load();
      const state = store.project('p');
      expect(state.currentSnapshot?.version).toBe(4);
      expect(state.jobs['job-old']?.state).toBe('error');
      expect(state.jobs['job-old']?.error).toContain('中断');
      // Persisted migration is idempotent.
      const store2 = new StateStore(statePath);
      await store2.load();
      expect(store2.project('p').jobs['job-old']?.state).toBe('error');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).projects.p.jobs['job-old'].state).toBe('error');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it('drops an incompatible snapshot instead of failing startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archsync-upgrade-bad-'));
    try {
      const statePath = join(root, 'state.json');
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        projects: { p: { nextVersion: 2, currentSnapshot: { version: 1, modules: 'not-an-array' }, jobs: {} } },
      }));
      const store = new StateStore(statePath);
      await store.load();
      expect(store.project('p').currentSnapshot).toBeNull();
      expect(store.project('p').nextVersion).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it('serializes concurrent mutations so rebuilds cannot corrupt the state file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archsync-upgrade-serialize-'));
    try {
      const statePath = join(root, 'state.json');
      const store = new StateStore(statePath);
      await store.load();
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate((data) => {
        data.projects[`p${i}`] = { nextVersion: 1, currentSnapshot: null, lastContentHash: null, annotations: {}, annotationRevisions: [], jobs: {} };
      })));
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(Object.keys(parsed.projects)).toHaveLength(20);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });
});

describe('startup does not wait for repository scans', () => {
  it('listens and serves the persisted snapshot before background rebuilds finish', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archsync-startup-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    process.env.ARCHSYNC_DATA_DIR = dataDir;
    process.env.WORKSPACE_ROOT = join(root, 'workspace');
    mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
    process.env.PORT = '0';
    const repo = makeRepo(root, 120);
    let server = await createServer({ repoRoot: root, quiet: true });
    try {
      const added = await fetch(server.url + '/api/v1/registry/add-local', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: repo }),
      });
      expect(added.status).toBe(201);
      const { project } = (await added.json()) as { project: { id: string } };
      for (let i = 0; i < 300; i++) {
        const index = (await (await fetch(server.url + `/api/v1/projects/${project.id}/code-index`)).json()) as { state: string };
        if (index.state === 'ready') break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      const before = (await (await fetch(server.url + `/api/v1/projects/${project.id}/snapshot`)).json()) as { version: number };
      expect(before.version).toBeGreaterThan(0);
      await server.close();

      // Restart with the same data directory: listen must not wait for scans.
      const started = Date.now();
      server = await createServer({ repoRoot: root, quiet: true });
      const listenMs = Date.now() - started;
      expect(listenMs).toBeLessThan(5_000);
      const health = (await (await fetch(server.url + '/healthz')).json()) as { ok: boolean; startup: { listenMs: number | null; background: { total: number } } };
      expect(health.ok).toBe(true);
      expect(health.startup.listenMs).not.toBeNull();
      expect(health.startup.background.total).toBeGreaterThan(0);
      const snapshotResponse = await fetch(server.url + `/api/v1/projects/${project.id}/snapshot`);
      expect(snapshotResponse.status).toBe(200);
      const snapshot = (await snapshotResponse.json()) as { version: number };
      expect(snapshot.version).toBeGreaterThanOrEqual(before.version);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 60_000);
});
