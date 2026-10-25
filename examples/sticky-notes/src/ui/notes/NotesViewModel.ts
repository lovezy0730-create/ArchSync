import type { NoteSummary } from '../../services/note/NoteService';

export interface NotesViewState {
  notes: NoteSummary[];
  activeId: string | null;
  query: string;
}

/** 纯函数：按搜索词过滤笔记列表（供测试直接使用）。 */
export function filterNotes(state: NotesViewState): NoteSummary[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.notes;
  return state.notes.filter(
    (n) => n.title.toLowerCase().includes(q) || n.preview.toLowerCase().includes(q),
  );
}
