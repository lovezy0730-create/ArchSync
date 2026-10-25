import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../src/diff.js';
import type { ModuleState, Snapshot } from '@archsync/contracts';

const mod = (id: string, over: Partial<ModuleState> = {}): ModuleState => ({
  id,
  label: id,
  layer: 'ui',
  description: '',
  plannedPaths: [],
  plannedDependsOn: [],
  dependedOnBy: [],
  matchedBaselinePaths: [],
  matchedWorkspacePaths: [],
  overlayChanges: [],
  observedDependsOn: null,
  implementation: 'not_detected',
  workflow: 'not_started',
  owners: [],
  assignees: [],
  contributors: [],
  issueNumbers: [],
  pullRequestNumbers: [],
  evidence: [],
  warnings: [],
  ...over,
});

const snap = (version: number, modules: ModuleState[], edges: Snapshot['edges']): Snapshot => ({
  id: `s${version}`,
  projectId: 'p',
  projectName: 'P',
  version,
  branch: 'main',
  sourceCommitSha: `${version}`.padEnd(40, '0'),
  configBlobSha: 'c'.repeat(40),
  scope: 'local-workspace',
  generatedAt: `2026-01-0${version}T00:00:00Z`,
  githubFetchedAt: null,
  githubSource: 'live',
  githubDemo: false,
  freshness: 'fresh',
  scanCompleteness: 'complete',
  dependencyAnalysis: 'not_supported',
  layers: [{ id: 'ui', label: 'UI', order: 1 }],
  modules,
  edges,
  warnings: [],
  contentHash: `h${version}`,
});

describe('diffSnapshots', () => {
  it('reports added/removed modules, state changes and edge drift', () => {
    const v1 = snap(1, [mod('a'), mod('b', { workflow: 'in_progress' })], [
      { id: 'a->b', source: 'a', target: 'b', kind: 'planned', demo: false },
    ]);
    const v2 = snap(2, [
      mod('a', { implementation: 'detected_unverified' }),
      mod('b', { workflow: 'done', matchedWorkspacePaths: ['x.ts'] }),
      mod('c'),
    ], [
      { id: 'a->b', source: 'a', target: 'b', kind: 'confirmed', demo: false },
      { id: 'a->c', source: 'a', target: 'c', kind: 'observed', demo: false },
    ]);

    const diff = diffSnapshots(v1, v2);
    expect(diff.modules).toEqual([{ id: 'c', label: 'c', change: 'added' }]);
    expect(diff.stateChanges).toContainEqual({
      id: 'a', label: 'a', field: 'implementation', from: 'not_detected', to: 'detected_unverified',
    });
    expect(diff.stateChanges).toContainEqual({
      id: 'b', label: 'b', field: 'workflow', from: 'in_progress', to: 'done',
    });
    expect(diff.edges.map((e) => e.id)).toEqual(['a->c']);
    expect(diff.matchedFilesDelta).toEqual([
      { id: 'b', label: 'b', from: 0, to: 1 },
    ]);
    expect(diff.to.version).toBe(2);
  });

  it('identical snapshots produce an empty diff', () => {
    const v = snap(1, [mod('a')], []);
    const diff = diffSnapshots(v, { ...v, version: 2, generatedAt: '2026-01-02T00:00:00Z' });
    expect(diff.modules).toEqual([]);
    expect(diff.stateChanges).toEqual([]);
    expect(diff.edges).toEqual([]);
  });
});
