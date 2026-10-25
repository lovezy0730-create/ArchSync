import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Snapshot, SyncJobStatus } from '@archsync/contracts';

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

  /** Serialized mutation: apply fn then persist. Single-process only. */
  async mutate<T>(fn: (data: StoreData) => T): Promise<T> {
    const result = fn(this.data);
    await this.persist();
    return result;
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
