import { describe, expect, it } from 'vitest';
import type { ModuleState, ProjectViewConfig, Snapshot } from '@archsync/contracts';
import {
  VIEW_GROUP_GAP,
  VIEW_GROUP_WIDTH,
  layoutProjectView,
  resolveViewGroups,
  snapshotViews,
} from '../src/lib/view-layout.js';

const module = (id: string, layer = 'ui'): ModuleState => ({
  id,
  label: id,
  layer,
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
});

const modules = [module('a'), module('b'), module('c', 'svc'), module('d', 'svc')];

const view: ProjectViewConfig = {
  id: 'systems',
  label: '系统视图',
  kind: 'system',
  direction: 'LR',
  description: '',
  groups: [
    { id: 'client', label: '客户端', order: 1, tone: 'blue', moduleIds: ['a', 'b'] },
    { id: 'server', label: '服务端', order: 2, tone: 'purple', moduleIds: ['c'] },
  ],
};

const snapshot = (views?: ProjectViewConfig[]): Snapshot => ({
  id: 's', projectId: 'p', projectName: 'P', version: 1, branch: 'main',
  sourceCommitSha: 'a'.repeat(40), configBlobSha: 'b'.repeat(40), scope: 'local-workspace',
  generatedAt: '2026-01-01T00:00:00Z', githubFetchedAt: null, githubSource: 'unavailable',
  githubDemo: false, freshness: 'fresh', scanCompleteness: 'complete',
  dependencyAnalysis: 'not_supported',
  layers: [
    { id: 'ui', label: 'UI', order: 1 },
    { id: 'svc', label: 'Services', order: 2 },
  ],
  views,
  defaultViewId: views?.[0]?.id,
  modules,
  edges: [], warnings: [], contentHash: 'x',
});

describe('project view layout', () => {
  it('builds an automatic layer view for older snapshots', () => {
    const views = snapshotViews(snapshot());
    expect(views).toHaveLength(1);
    expect(views[0]?.groups.map((group) => group.id)).toEqual(['ui', 'svc']);
    expect(views[0]?.groups[0]?.moduleIds).toEqual(['a', 'b']);
  });

  it('applies group and module order overrides and appends unassigned modules', () => {
    const groups = resolveViewGroups(view, modules, {
      groupOrder: ['server', 'client', '__other__'],
      moduleOrder: { client: ['b', 'a'] },
    });
    expect(groups.map((group) => group.id)).toEqual(['server', 'client', '__other__']);
    expect(groups.find((group) => group.id === 'client')?.moduleIds).toEqual(['b', 'a']);
    expect(groups.find((group) => group.id === '__other__')?.moduleIds).toEqual(['d']);
  });

  it('lays groups out left-to-right without overlapping columns', () => {
    const layout = layoutProjectView(view, modules);
    expect(layout.positions.get('a')).toEqual({ x: 60, y: 98 });
    expect(layout.positions.get('c')?.x).toBe(40 + VIEW_GROUP_WIDTH + VIEW_GROUP_GAP + 20);
    expect(layout.groupBoxes[1]!.x - layout.groupBoxes[0]!.x).toBe(VIEW_GROUP_WIDTH + VIEW_GROUP_GAP);
    expect(layout.canvasSize.width).toBeGreaterThan(VIEW_GROUP_WIDTH * 2);
  });

  it('supports top-to-bottom group ordering', () => {
    const layout = layoutProjectView({ ...view, direction: 'TB' }, modules.slice(0, 3));
    expect(layout.groupBoxes[1]!.y).toBeGreaterThan(layout.groupBoxes[0]!.y);
    expect(layout.positions.get('a')!.x).toBeLessThan(layout.positions.get('b')!.x);
  });

  it('wraps modules and keeps TB group rows compact', () => {
    const oneGroup = layoutProjectView({
      ...view,
      direction: 'TB',
      groups: [{ id: 'all', label: '全部', order: 1, tone: 'blue', moduleIds: ['a', 'b', 'c', 'd'] }],
    }, modules);
    expect(oneGroup.positions.get('a')!.y).toBe(oneGroup.positions.get('c')!.y);
    expect(oneGroup.positions.get('d')!.y).toBeGreaterThan(oneGroup.positions.get('a')!.y);

    const tallView: ProjectViewConfig = {
      ...view,
      direction: 'TB',
      groups: [
        { id: 'g1', label: 'G1', order: 1, tone: 'blue', moduleIds: ['a'] },
        { id: 'g2', label: 'G2', order: 2, tone: 'purple', moduleIds: ['b'] },
        { id: 'g3', label: 'G3', order: 3, tone: 'cyan', moduleIds: ['c'] },
        { id: 'g4', label: 'G4', order: 4, tone: 'green', moduleIds: ['d'] },
        { id: 'g5', label: 'G5', order: 5, tone: 'amber', moduleIds: [] },
        { id: 'g6', label: 'G6', order: 6, tone: 'gray', moduleIds: [] },
      ],
    };
    const compact = layoutProjectView(tallView, modules);
    expect(compact.canvasSize.height).toBeLessThan(1120);
    expect(compact.groupBoxes[1]!.y - compact.groupBoxes[0]!.y).toBeLessThan(180);
  });
});