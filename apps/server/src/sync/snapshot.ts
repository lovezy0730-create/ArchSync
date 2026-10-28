import { randomUUID } from 'node:crypto';
import type { Snapshot, SyncJobStatus } from '@archsync/contracts';
import { buildSnapshot } from '@archsync/graph';
import { scanProject } from '@archsync/scanner';
import { loadCollab } from '../github.js';
import type { ProjectEntry } from '../projects.js';
import { emptyProjectState, type StateStore } from '../store/index.js';

export interface RebuildResult {
  snapshot: Snapshot | null;
  changed: boolean;
  jobId: string;
  error: string | null;
}

/**
 * Scan → merge → publish. If the merged content hash is unchanged, the
 * current snapshot is kept and no new version is emitted (T17).
 */
export async function rebuildSnapshot(
  entry: ProjectEntry,
  store: StateStore,
  githubToken: string | null,
  jobId: string = randomUUID(),
  cacheReader?: { readCache: <T>(projectId: string, kind: string) => T | null },
): Promise<RebuildResult> {
  await store.mutate((data) => {
    const p = data.projects[entry.id] ?? (data.projects[entry.id] = emptyProjectState());
    p.jobs[jobId] = {
      id: jobId,
      projectId: entry.id,
      state: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
  });

  try {
    const scan = await scanProject(entry.config, entry.rootDir);
    const collab = await loadCollab(entry, githubToken, cacheReader);
    const state = store.project(entry.id);
    const candidate = buildSnapshot({
      config: entry.config,
      configWarnings: entry.configWarnings,
      viewDiagnostics: entry.viewDiagnostics,
      views: entry.views,
      defaultViewId: entry.defaultViewId,
      configBlobSha: entry.configBlobSha,
      scan,
      collab,
      version: state.nextVersion,
      snapshotId: `snap-${entry.id}-${state.nextVersion}`,
      now: new Date().toISOString(),
    });

    let changed = false;
    await store.mutate((data) => {
      const p = data.projects[entry.id]!;
      if (p.lastContentHash !== candidate.contentHash || p.currentSnapshot === null) {
        p.currentSnapshot = candidate;
        p.lastContentHash = candidate.contentHash;
        p.nextVersion = candidate.version + 1;
        changed = true;
      }
      p.jobs[jobId]!.state = 'done';
      p.jobs[jobId]!.finishedAt = new Date().toISOString();
    });
    return { snapshot: store.project(entry.id).currentSnapshot, changed, jobId, error: null };
  } catch (err) {
    const message = (err as Error).message;
    await store.mutate((data) => {
      const p = data.projects[entry.id]!;
      p.jobs[jobId]!.state = 'error';
      p.jobs[jobId]!.finishedAt = new Date().toISOString();
      p.jobs[jobId]!.error = message;
    });
    return { snapshot: store.project(entry.id).currentSnapshot, changed: false, jobId, error: message };
  }
}


export function jobStatus(store: StateStore, projectId: string, jobId: string): SyncJobStatus | null {
  return store.project(projectId).jobs[jobId] ?? null;
}
