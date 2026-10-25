import { useMemo } from 'react';
import type { NoteSummary } from '../../services/note/NoteService';

export interface NotesListProps {
  notes: NoteSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

/** 主界面左侧笔记列表。 */
export function NotesList({ notes, activeId, onSelect }: NotesListProps) {
  const sorted = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt), [notes]);
  return (
    <ul className="notes-list" role="listbox" aria-label="笔记列表">
      {sorted.map((note) => (
        <li
          key={note.id}
          role="option"
          aria-selected={note.id === activeId}
          className={note.id === activeId ? 'active' : ''}
          onClick={() => onSelect(note.id)}
        >
          <span className="title">{note.title || '(无标题)'}</span>
          <span className="preview">{note.preview}</span>
        </li>
      ))}
    </ul>
  );
}
