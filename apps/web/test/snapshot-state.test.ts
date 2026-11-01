import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabDataSchema, type ProjectConfigFile, type ScanResult } from '@archsync/contracts';
import { buildSnapshot } from '@archsync/graph';
import { useStore } from '../src/store.js';

function makeSnapshotFor(projectId: string) {
  const config: ProjectConfigFile = {
    schemaVersion: 1,
    project: { id: projectId, name: 'P', github: { owner: '', repo: '', defaultBranch: 'main' }, root: '.' },
    layers: [{ id: 'layer-1', label: 'L', order: 1 }],
    modules: [
      {
        id: 'module-1', label: 'M', layer: 'layer-1', description: '', owners: [], paths: ['src/**'], issues: [],
        plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false },
      },
    ],
  };
  const scan: ScanResult = {
    ok: true,
    baselineSha: 'a'.repeat(40),
    branch: 'main',
    baselineFiles: ['src/a.ts'],
    workspaceFiles: ['src/a.ts'],
    overlay: [],
    modules: [{ moduleId: 'module-1', matchedBaselinePaths: ['src/a.ts'], matchedWorkspacePaths: ['src/a.ts'], overlayChanges: [], overlappedWith: [] }],
    errors: [],
    scannedAt: new Date().toISOString(),
    importAnalysisRan: true,
    observedDependencies: [],
  };
  return buildSnapshot({
    config,
    configWarnings: [],
    configBlobSha: 'sha',
    scan,
    collab: CollabDataSchema.parse({ source: 'unavailable', demo: false, fetchedAt: new Date().toISOString(), error: 'no token' }),
    version: 3,
    snapshotId: `snap-${projectId}-3`,
    now: new Date().toISOString(),
    configOrigin: 'inferred',
  });
}

type Behaviour = { snapshot: 'ok' | 'fail' | 'pending'; team: 'ok' | 'fail' };

function installFetch(behaviour: Behaviour, projectId: string) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/v1/me')) return json({ mode: 'mock', authenticated: true, identity: null });
    if (url.includes('/api/v1/projects') && !url.includes('/api/v1/projects/')) {
      return json({
        projects: [{
          id: projectId, name: 'P',
          github: { owner: '', repo: '', defaultBranch: 'main' },
          rootDir: '/p', demoCollab: false, moduleCount: 1, currentVersion: 3,
        }],
      });
    }
    if (url.includes('/api/v1/workspace/active-project')) return json({ projectId });
    if (url.includes(`/api/v1/projects/${projectId}/snapshot`)) {
      if (behaviour.snapshot === 'ok') return json(makeSnapshotFor(projectId));
      if (behaviour.snapshot === 'pending') return json({ error: { code: 'snapshot_pending', message: '正在生成', jobId: 'job-1' } }, 503);
      return json({ error: { code: 'snapshot_failed', message: '模拟失败' } }, 503);
    }
    if (url.includes(`/api/v1/projects/${projectId}/team`)) {
      if (behaviour.team === 'ok') return json({ team: [{ login: 'alice', name: 'alice', role: 'owner' }], demo: false });
      return json({ error: { message: 'team failed' } }, 500);
    }
    return json({}, 404);
  });
}

beforeEach(() => {
  useStore.setState({
    booted: false,
    projectId: null,
    snapshot: null,
    snapshotStatus: 'idle',
    snapshotError: null,
    snapshotJobId: null,
    team: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('snapshot lifecycle is independent from team data', () => {
  it('shows the architecture snapshot even when the team request fails', async () => {
    installFetch({ snapshot: 'ok', team: 'fail' }, 'p-ok');
    await useStore.getState().boot();
    const state = useStore.getState();
    expect(state.snapshotStatus).toBe('ready');
    expect(state.snapshot?.version).toBe(3);
    expect(state.team).toEqual([]);
  });

  it('surfaces a concrete snapshot failure and recovers on retry', async () => {
    installFetch({ snapshot: 'fail', team: 'ok' }, 'p-fail');
    await useStore.getState().boot();
    expect(useStore.getState().snapshotStatus).toBe('error');
    expect(useStore.getState().snapshotError).toContain('模拟失败');
    installFetch({ snapshot: 'ok', team: 'ok' }, 'p-fail');
    await useStore.getState().retrySnapshot();
    expect(useStore.getState().snapshotStatus).toBe('ready');
    expect(useStore.getState().snapshot?.version).toBe(3);
  });

  it('marks a first-time rebuild as pending instead of loading forever', async () => {
    installFetch({ snapshot: 'pending', team: 'ok' }, 'p-pending');
    await useStore.getState().boot();
    const state = useStore.getState();
    expect(state.snapshotStatus).toBe('pending');
    expect(state.snapshotJobId).toBe('job-1');
    expect(state.snapshot).toBeNull();
    // Let the bounded poll notice that the project changed and stop.
    useStore.setState({ projectId: 'other' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_700));
  });
});
