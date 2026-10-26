import type { Snapshot } from '@archsync/contracts';

/**
 * Pure snapshot diff — shared by the history UI and the Agent CLI.
 * Compares module sets, per-module states, and dependency edges.
 */
export interface ModuleDiffEntry {
  id: string;
  label: string;
  change: 'added' | 'removed';
}

export interface StateChangeEntry {
  id: string;
  label: string;
  field: 'implementation' | 'workflow';
  from: string;
  to: string;
}

export interface EdgeDiffEntry {
  id: string;
  source: string;
  target: string;
  kind: string | null;
  change: 'added' | 'removed';
}

export interface SnapshotDiff {
  /** base → head version labels */
  from: { version: number; generatedAt: string; sourceCommitSha: string };
  to: { version: number; generatedAt: string; sourceCommitSha: string };
  modules: ModuleDiffEntry[];
  stateChanges: StateChangeEntry[];
  edges: EdgeDiffEntry[];
  matchedFilesDelta: Array<{ id: string; label: string; from: number; to: number }>;
}

export function diffSnapshots(base: Snapshot, head: Snapshot): SnapshotDiff {
  const baseModules = new Map(base.modules.map((m) => [m.id, m]));
  const headModules = new Map(head.modules.map((m) => [m.id, m]));

  const modules: ModuleDiffEntry[] = [];
  for (const m of head.modules) {
    if (!baseModules.has(m.id)) modules.push({ id: m.id, label: m.label, change: 'added' });
  }
  for (const m of base.modules) {
    if (!headModules.has(m.id)) modules.push({ id: m.id, label: m.label, change: 'removed' });
  }

  const stateChanges: StateChangeEntry[] = [];
  const matchedFilesDelta: SnapshotDiff['matchedFilesDelta'] = [];
  for (const after of head.modules) {
    const before = baseModules.get(after.id);
    if (!before) continue;
    if (before.implementation !== after.implementation) {
      stateChanges.push({
        id: after.id,
        label: after.label,
        field: 'implementation',
        from: before.implementation,
        to: after.implementation,
      });
    }
    if (before.workflow !== after.workflow) {
      stateChanges.push({
        id: after.id,
        label: after.label,
        field: 'workflow',
        from: before.workflow,
        to: after.workflow,
      });
    }
    if (before.matchedWorkspacePaths.length !== after.matchedWorkspacePaths.length) {
      matchedFilesDelta.push({
        id: after.id,
        label: after.label,
        from: before.matchedWorkspacePaths.length,
        to: after.matchedWorkspacePaths.length,
      });
    }
  }

  const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
  const headEdges = new Map(head.edges.map((e) => [e.id, e]));
  const edges: EdgeDiffEntry[] = [];
  for (const e of head.edges) {
    if (!baseEdges.has(e.id)) edges.push({ ...e, kind: e.kind, change: 'added' });
  }
  for (const e of base.edges) {
    if (!headEdges.has(e.id)) edges.push({ ...e, kind: e.kind, change: 'removed' });
  }

  return {
    from: {
      version: base.version,
      generatedAt: base.generatedAt,
      sourceCommitSha: base.sourceCommitSha,
    },
    to: {
      version: head.version,
      generatedAt: head.generatedAt,
      sourceCommitSha: head.sourceCommitSha,
    },
    modules,
    stateChanges,
    edges,
    matchedFilesDelta,
  };
}
