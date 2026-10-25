import type { NoteRecord } from '../note/NoteRepository';

export interface SyncPlan {
  push: NoteRecord[];
  pull: NoteRecord[];
  conflicts: string[];
}

/** 多设备增量同步：计算本地与远端的差异计划。 */
export function computeSyncPlan(local: NoteRecord[], remote: NoteRecord[]): SyncPlan {
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const localById = new Map(local.map((l) => [l.id, l]));
  const push = local.filter((l) => {
    const r = remoteById.get(l.id);
    return r === undefined || l.updatedAt > r.updatedAt;
  });
  const pull = remote.filter((r) => {
    const l = localById.get(r.id);
    return l === undefined || r.updatedAt > l.updatedAt;
  });
  const conflicts = local
    .filter((l) => {
      const r = remoteById.get(l.id);
      return r !== undefined && l.updatedAt > r.updatedAt && r.updatedAt > l.createdAt;
    })
    .map((l) => l.id);
  return { push, pull, conflicts };
}
