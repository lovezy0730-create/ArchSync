import { it, expect, vi } from 'vitest';
import { CollabDataSchema, type ProjectConfigFile, type ScanResult, type Snapshot } from '@archsync/contracts';
import { buildSnapshot } from '@archsync/graph';
const mocks = vi.hoisted(() => ({loadSnapshot:vi.fn(),loadTeam:vi.fn(async()=>({team:[],demo:false}))}));
vi.mock('../src/lib/server-provider.js',()=>({createServerProvider:()=>({capabilities:{presence:false},...mocks})}));
import { useStore } from '../src/store.js';
it('late project A response cannot replace selected project B', async () => {
  let finishA!: (snapshot:Snapshot)=>void;
  const a = new Promise<Snapshot>(resolve => {finishA=resolve;});
  const snapshot = (id: string) => {
    const config: ProjectConfigFile = {
      schemaVersion: 1,
      project: { id, name: id, github: { owner: '', repo: '', defaultBranch: 'main' }, root: '.' },
      layers: [{ id: 'layer-1', label: 'L', order: 1 }],
      modules: [{ id: 'module-1', label: 'M', layer: 'layer-1', description: '', owners: [], paths: ['src/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } }],
    };
    const scan: ScanResult = {
      ok: true, baselineSha: 'a'.repeat(40), branch: 'main', baselineFiles: [], workspaceFiles: [], overlay: [],
      modules: [], errors: [], scannedAt: new Date().toISOString(), importAnalysisRan: false, observedDependencies: [],
    };
    return buildSnapshot({
      config, configWarnings: [], configBlobSha: 'sha', scan,
      collab: CollabDataSchema.parse({ source: 'unavailable', demo: false, fetchedAt: new Date().toISOString(), error: null }),
      version: 1, snapshotId: `snap-${id}`, now: new Date().toISOString(),
    });
  };
  mocks.loadSnapshot.mockImplementation((id:string)=>id==='a'?a:Promise.resolve(snapshot('b')));
  const pending = useStore.getState().switchProject('a');
  await useStore.getState().switchProject('b');
  finishA(snapshot('a')); await pending;
  expect(useStore.getState().projectId).toBe('b');
  expect(useStore.getState().snapshot?.projectId).toBe('b');
});
