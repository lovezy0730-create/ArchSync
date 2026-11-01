import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { SnapshotSchema, type Snapshot, type SyncJobStatus } from '@archsync/contracts';

export interface StoredAnnotation {
  text: string;
  revision: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AnnotationRevision {
  moduleId: string;
  revision: number;
  text: string;
  author: string;
  createdAt: string;
}

export interface StoredProjectState {
  nextVersion: number;
  currentSnapshot: Snapshot | null;
  lastContentHash: string | null;
  annotations: Record<string, StoredAnnotation>;
  annotationRevisions: AnnotationRevision[];
  jobs: Record<string, SyncJobStatus>;
}

export interface StoreData {
  version: 1;
  projects: Record<string, StoredProjectState>;
}

export function emptyProjectState(): StoredProjectState {
  return {
    nextVersion: 1,
    currentSnapshot: null,
    lastContentHash: null,
    annotations: {},
    annotationRevisions: [],
    jobs: {},
  };
}

/**
 * Single-instance JSON file store (MVP). Writes are atomic-ish
 * (tmp file + rename). The store interface is deliberately narrow so a
 * SQLite migration can replace it without touching callers.
 */
export class StateStore {
  private data: StoreData;
  private readonly filePath: string;
  /** Serializes mutations; concurrent rebuilds must not interleave persist(). */
  private tail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = { version: 1, projects: {} };
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreData;
      if (raw && raw.version === 1 && typeof raw.projects === 'object') {
        this.data = raw;
        if (this.migrateLoadedState()) await this.persist();
      }
    } catch (err) {
      // Corrupt state file must not crash the server; start fresh but keep
      // the broken file for inspection.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await rename(this.filePath, backup).catch(() => undefined);
      throw new Error(
        `状态文件损坏，已备份到 ${backup} 并从空状态启动: ${(err as Error).message}`,
      );
    }
  }

  project(id: string): StoredProjectState {
    return this.data.projects[id] ?? emptyProjectState();
  }

  /**
   * Old data upgrade:
   * - jobs left in `running` by a previous process become explicit errors
   *   instead of pretending to be alive forever;
   * - missing counters/collections get safe defaults;
   * - snapshots are validated; an incompatible one is dropped so the project
   *   rebuilds instead of crashing the renderer.
   */
  private migrateLoadedState(): boolean {
    let changed = false;
    for (const [id, state] of Object.entries(this.data.projects)) {
      if (!state || typeof state !== 'object') {
        this.data.projects[id] = emptyProjectState();
        changed = true;
        continue;
      }
      if (typeof state.nextVersion !== 'number' || !Number.isFinite(state.nextVersion) || state.nextVersion < 1) {
        state.nextVersion = 1;
        changed = true;
      }
      if (!state.jobs || typeof state.jobs !== 'object') {
        state.jobs = {};
        changed = true;
      }
      if (!state.annotations || typeof state.annotations !== 'object') {
        state.annotations = {};
        changed = true;
      }
      if (!Array.isArray(state.annotationRevisions)) {
        state.annotationRevisions = [];
        changed = true;
      }
      for (const job of Object.values(state.jobs)) {
        if (!job || typeof job !== 'object') continue;
        if (job.state === 'running') {
          job.state = 'error';
          job.error = job.error ?? '上次运行在应用退出时中断（未完成的重建）';
          job.finishedAt = job.finishedAt ?? new Date().toISOString();
          changed = true;
        }
      }
      if (state.currentSnapshot) {
        const parsed = SnapshotSchema.safeParse(state.currentSnapshot);
        if (parsed.success) {
          state.currentSnapshot = parsed.data;
        } else {
          state.currentSnapshot = null;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Serialized mutation: apply fn then persist. Single-process only. */
  mutate<T>(fn: (data: StoreData) => T): Promise<T> {
    const run = this.tail.then(async () => {
      const result = fn(this.data);
      await this.persist();
      return result;
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    try {
      await rename(tmp, this.filePath);
    } catch {
      // Windows rename-over-existing can fail; remove then rename.
      const { rm } = await import('node:fs/promises');
      await rm(this.filePath, { force: true });
      await rename(tmp, this.filePath);
    }
  }

  hash(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
