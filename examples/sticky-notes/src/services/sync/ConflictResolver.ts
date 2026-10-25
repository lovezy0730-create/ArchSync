import type { NoteRecord } from '../note/NoteRepository';

/** 冲突解决策略：保留双方版本， newest wins + 保留 loser 副本。 */
export function resolveConflict(a: NoteRecord, b: NoteRecord): {
  winner: NoteRecord;
  loserCopyId: string;
} {
  const winner = a.updatedAt >= b.updatedAt ? a : b;
  const loser = a.updatedAt >= b.updatedAt ? b : a;
  return { winner, loserCopyId: `${loser.id}::conflict-${loser.updatedAt}` };
}
