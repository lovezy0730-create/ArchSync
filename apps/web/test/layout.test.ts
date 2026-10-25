import { describe, expect, it } from 'vitest';
import type { ModuleState, Snapshot } from '@archsync/contracts';
import {
  dependencyClosure,
  isEdgeOnPath,
  layoutSnapshot,
  matchesSearch,
} from '../src/lib/layout.js';

const module = (id: string, deps: string[], layer = 'ui'): ModuleState => ({
  id,
  label: id,
  layer,
  description: '',
  plannedPaths: [],
  plannedDependsOn: deps,
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
});

const snapshot = (modules: ModuleState[]): Snapshot => ({
  id: 's',
  projectId: 'p',
  projectName: 'P',
  version: 1,
  branch: 'main',
  sourceCommitSha: 'a'.repeat(40),
  configBlobSha: 'b'.repeat(40),
  scope: 'local-workspace',
  generatedAt: '2026-01-01T00:00:00Z',
  githubFetchedAt: null,
  githubSource: 'unavailable',
  githubDemo: false,
  freshness: 'fresh',
  scanCompleteness: 'complete',
  dependencyAnalysis: 'not_supported',
  layers: [
    { id: 'ui', label: 'UI', order: 1 },
    { id: 'svc', label: 'Services', order: 2 },
  ],
  modules,
  edges: [],
  warnings: [],
  contentHash: 'x',
});

describe('dependencyClosure', () => {
  it('finds transitive upstream and downstream separately', () => {
    const modules = [
      module('a', []),
      module('b', ['a']),
      module('c', ['b']),
      module('d', ['c']),
      module('e', []),
    ];
    const { upstream, downstream } = dependencyClosure(modules, 'c');
    expect(upstream).toEqual(new Set(['b', 'a']));
    expect(downstream).toEqual(new Set(['d']));
    const none = dependencyClosure(modules, 'e');
    expect(none.upstream.size).toBe(0);
    expect(none.downstream.size).toBe(0);
  });

  it('handles cycles without infinite recursion', () => {
    const modules = [module('x', ['y']), module('y', ['x']), module('z', ['x'])];
    const { upstream, downstream } = dependencyClosure(modules, 'x');
    expect(upstream).toEqual(new Set(['y']));
    // in a cycle y is both an ancestor and a descendant of x
    expect(downstream).toEqual(new Set(['y', 'z']));
  });
});

describe('isEdgeOnPath', () => {
  const up = new Set(['u1', 'u2']);
  const down = new Set(['d1', 'd2']);

  it('matches edges along upstream chain', () => {
    expect(isEdgeOnPath({ source: 'u1', target: 'sel' }, 'sel', up, down)).toBe(true);
    expect(isEdgeOnPath({ source: 'u2', target: 'u1' }, 'sel', up, down)).toBe(true);
  });

  it('matches edges along downstream chain', () => {
    expect(isEdgeOnPath({ source: 'sel', target: 'd1' }, 'sel', up, down)).toBe(true);
    expect(isEdgeOnPath({ source: 'd1', target: 'd2' }, 'sel', up, down)).toBe(true);
  });

  it('rejects unrelated edges', () => {
    expect(isEdgeOnPath({ source: 'u1', target: 'other' }, 'sel', up, down)).toBe(false);
    expect(isEdgeOnPath({ source: 'x', target: 'y' }, 'sel', up, down)).toBe(false);
    expect(isEdgeOnPath({ source: 'd1', target: 'u1' }, 'sel', up, down)).toBe(false);
  });
});

describe('matchesSearch', () => {
  const m = { ...module('note-service', []), label: '笔记管理服务', owners: ['mu-ran'] };
  it('matches id, label and owners case-insensitively', () => {
    expect(matchesSearch(m, 'note')).toBe(true);
    expect(matchesSearch(m, '笔记')).toBe(true);
    expect(matchesSearch(m, 'MU-RAN')).toBe(true);
    expect(matchesSearch(m, 'ghost')).toBe(false);
    expect(matchesSearch(m, '  ')).toBe(true);
  });
});

describe('layoutSnapshot', () => {
  it('assigns one column per layer and deterministic rows', () => {
    const snap = snapshot([
      module('a', [], 'ui'),
      module('b', [], 'svc'),
      module('c', [], 'ui'),
    ]);
    const { nodes, columns, canvasSize } = layoutSnapshot(snap);
    expect(columns.map((c) => c.layerId)).toEqual(['ui', 'svc']);
    const a = nodes.find((n) => n.id === 'a')!;
    const c = nodes.find((n) => n.id === 'c')!;
    const b = nodes.find((n) => n.id === 'b')!;
    expect(a.x).toBe(c.x);
    expect(c.y).toBeGreaterThan(a.y);
    expect(b.x).toBeGreaterThan(a.x);
    expect(canvasSize.width).toBeGreaterThan(0);
    expect(canvasSize.height).toBeGreaterThan(0);
  });
});
