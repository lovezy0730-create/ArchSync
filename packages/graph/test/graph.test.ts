import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../src/index.js';
import type {
  CollabData,
  DemoIssue,
  DemoPullRequest,
  ProjectConfigFile,
  ScanResult,
} from '@archsync/contracts';

const NOW = '2026-10-25T10:00:00.000Z';

const config: ProjectConfigFile = {
  schemaVersion: 1,
  project: {
    id: 'demo',
    name: 'Demo',
    github: { owner: 'o', repo: 'r', defaultBranch: 'main' },
    root: '.',
  },
  layers: [{ id: 'ui', label: 'UI', order: 1 }],
  modules: [
    {
      id: 'mod-a',
      label: 'A',
      layer: 'ui',
      description: '',
      owners: ['alice'],
      paths: ['src/a/**'],
      issues: [1],
      plannedDependsOn: [],
      acceptance: { requiredIssues: [1], requiredChecks: ['lint'], manualApproval: true },
    },
    {
      id: 'mod-b',
      label: 'B',
      layer: 'ui',
      description: '',
      owners: [],
      paths: ['src/b/**'],
      issues: [],
      plannedDependsOn: ['mod-a'],
      acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false },
    },
  ],
};

const scanOf = (files: Record<string, string[]>): ScanResult => ({
  ok: true,
  baselineSha: 'a'.repeat(40),
  branch: 'main',
  baselineFiles: Object.values(files).flat(),
  workspaceFiles: Object.values(files).flat(),
  overlay: [],
  modules: Object.entries(files).map(([moduleId, paths]) => ({
    moduleId,
    matchedBaselinePaths: paths,
    matchedWorkspacePaths: paths,
    overlayChanges: [],
    overlappedWith: [],
  })),
  errors: [],
  scannedAt: NOW,
});

const issue = (n: number, over: Partial<DemoIssue> = {}): DemoIssue => ({
  number: n,
  title: `issue ${n}`,
  state: 'open',
  assignees: [],
  labels: [],
  author: 'alice',
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
  completion: 'none',
  ...over,
});

const pr = (n: number, over: Partial<DemoPullRequest> = {}): DemoPullRequest => ({
  number: n,
  title: `PR ${n}`,
  state: 'open',
  draft: false,
  author: 'bob',
  assignees: [],
  headRef: 'feat/x',
  mergedAt: null,
  closedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  changedFiles: ['src/a/x.ts'],
  checks: 'success',
  ...over,
});

const collabOf = (over: Partial<CollabData> = {}): CollabData => ({
  source: 'live',
  demo: false,
  fetchedAt: NOW,
  error: null,
  team: [],
  issues: [],
  pullRequests: [],
  moduleIssues: {},
  manualApprovals: {},
  ...over,
});

const build = (scan: ScanResult, collab: CollabData) =>
  buildSnapshot({
    config,
    configWarnings: [],
    configBlobSha: 'b'.repeat(40),
    scan,
    collab,
    version: 3,
    snapshotId: 'snap-3',
    now: NOW,
  });

describe('implementation state matrix', () => {
  it('T05: scan ok + zero matched files → not_detected with scan evidence', () => {
    const snap = build(scanOf({ 'mod-a': [], 'mod-b': ['src/b/main.ts'] }), collabOf());
    const a = snap.modules.find((m) => m.id === 'mod-a')!;
    expect(a.implementation).toBe('not_detected');
    expect(a.evidence.some((e) => e.source === 'git-tree')).toBe(true);
  });

  it('T06: scan failed → unknown, never not_detected', () => {
    const failed = { ...scanOf({ 'mod-a': ['src/a/x.ts'], 'mod-b': [] }), ok: false, baselineSha: null };
    const snap = build(failed, collabOf());
    for (const m of snap.modules) expect(m.implementation).toBe('unknown');
    expect(snap.scanCompleteness).toBe('unknown');
    expect(snap.warnings.some((w) => w.includes('unknown'))).toBe(true);
  });

  it('files exist but acceptance incomplete → detected_unverified; no rules → never verified', () => {
    const snap = build(
      scanOf({ 'mod-a': ['src/a/x.ts'], 'mod-b': ['src/b/y.ts'] }),
      collabOf({ issues: [issue(1, { state: 'open' })] }),
    );
    const a = snap.modules.find((m) => m.id === 'mod-a')!;
    expect(a.implementation).toBe('detected_unverified');
    const b = snap.modules.find((m) => m.id === 'mod-b')!;
    expect(b.implementation).toBe('detected_unverified');
  });

  it('all acceptance rules met → verified', () => {
    const snap = build(
      scanOf({ 'mod-a': ['src/a/x.ts'], 'mod-b': [] }),
      collabOf({
        issues: [issue(1, { state: 'closed', closedAt: NOW, completion: 'completed' })],
        pullRequests: [pr(10, { state: 'closed', mergedAt: NOW, checks: 'success' })],
        manualApprovals: { 'mod-a': ['alice'] },
      }),
    );
    expect(snap.modules.find((m) => m.id === 'mod-a')!.implementation).toBe('verified');
  });

  it('T07: no AST analysis → observedDependsOn null and dependencyAnalysis not_supported', () => {
    const snap = build(scanOf({ 'mod-a': [], 'mod-b': [] }), collabOf());
    expect(snap.dependencyAnalysis).toBe('not_supported');
    for (const m of snap.modules) expect(m.observedDependsOn).toBeNull();
    // planned edges still exist and are labelled planned-only
    expect(snap.edges).toEqual([
      { id: 'mod-b->mod-a', source: 'mod-b', target: 'mod-a', kind: 'planned', demo: false },
    ]);
  });
});

describe('workflow state matrix', () => {
  const files = { 'mod-a': ['src/a/x.ts'], 'mod-b': ['src/b/y.ts'] };

  it('open non-draft PR → in_review', () => {
    const snap = build(scanOf(files), collabOf({ pullRequests: [pr(9)] }));
    expect(snap.modules.find((m) => m.id === 'mod-a')!.workflow).toBe('in_review');
  });

  it('open issue or draft PR → in_progress', () => {
    const withIssue = build(scanOf(files), collabOf({ issues: [issue(1)] }));
    expect(withIssue.modules.find((m) => m.id === 'mod-a')!.workflow).toBe('in_progress');
    const withDraft = build(scanOf(files), collabOf({ pullRequests: [pr(9, { draft: true })] }));
    expect(withDraft.modules.find((m) => m.id === 'mod-a')!.workflow).toBe('in_progress');
  });

  it('T11: PR merged but required issue open → NOT done, warns instead', () => {
    const snap = build(
      scanOf(files),
      collabOf({
        issues: [issue(1, { state: 'open' })],
        pullRequests: [pr(10, { state: 'closed', mergedAt: NOW })],
      }),
    );
    const a = snap.modules.find((m) => m.id === 'mod-a')!;
    expect(a.workflow).not.toBe('done');
    expect(a.warnings.some((w) => w.includes('验收'))).toBe(true);
  });

  it('required issue completed + merged PR + approval → done', () => {
    const snap = build(
      scanOf(files),
      collabOf({
        issues: [issue(1, { state: 'closed', closedAt: NOW, completion: 'completed' })],
        pullRequests: [pr(10, { state: 'closed', mergedAt: NOW })],
        manualApprovals: { 'mod-a': ['alice'] },
      }),
    );
    expect(snap.modules.find((m) => m.id === 'mod-a')!.workflow).toBe('done');
  });

  it('no signals at all → not_started; blocked label wins', () => {
    const snap = build(scanOf(files), collabOf());
    expect(snap.modules.find((m) => m.id === 'mod-a')!.workflow).toBe('not_started');
    const blocked = build(scanOf(files), collabOf({ issues: [issue(1, { labels: ['blocked'] })] }));
    expect(blocked.modules.find((m) => m.id === 'mod-a')!.workflow).toBe('blocked');
  });

  it('assignees come from issues, contributors from PR authors, owners untouched', () => {
    const snap = build(
      scanOf(files),
      collabOf({
        issues: [issue(1, { assignees: ['carol', 'dave'] })],
        pullRequests: [pr(9, { author: 'erin' })],
      }),
    );
    const a = snap.modules.find((m) => m.id === 'mod-a')!;
    expect(a.assignees).toEqual(['carol', 'dave']);
    expect(a.contributors).toEqual(['erin']);
    expect(a.owners).toEqual(['alice']);
  });
});

describe('snapshot metadata', () => {
  it('flags demo collab data and marks freshness', () => {
    const snap = build(scanOf({ 'mod-a': [], 'mod-b': [] }), collabOf({ source: 'demo', demo: true }));
    expect(snap.githubSource).toBe('demo');
    expect(snap.githubDemo).toBe(true);
    expect(snap.warnings.some((w) => w.includes('演示数据'))).toBe(true);
    const failed = collabOf({ source: 'unavailable', error: 'token 无效' });
    expect(build(scanOf({ 'mod-a': [], 'mod-b': [] }), failed).freshness).toBe('stale');
  });

  it('content hash is stable for identical content and changes with state', () => {
    const scan = scanOf({ 'mod-a': ['src/a/x.ts'], 'mod-b': [] });
    const h1 = build(scan, collabOf()).contentHash;
    const h2 = build(scan, collabOf()).contentHash;
    expect(h1).toBe(h2);
    const h3 = build(
      scan,
      collabOf({ pullRequests: [pr(9)] }),
    ).contentHash;
    expect(h3).not.toBe(h1);
  });

  it('computes dependedOnBy reverse edges', () => {
    const snap = build(scanOf({ 'mod-a': [], 'mod-b': [] }), collabOf());
    expect(snap.modules.find((m) => m.id === 'mod-a')!.dependedOnBy).toEqual(['mod-b']);
    expect(snap.modules.find((m) => m.id === 'mod-b')!.dependedOnBy).toEqual([]);
  });
});
