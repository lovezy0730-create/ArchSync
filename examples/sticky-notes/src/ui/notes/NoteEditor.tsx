export interface NoteEditorProps {
  noteId: string;
  initialBody: string;
  onSave: (body: string) => Promise<void>;
}

/** 笔记正文编辑器，带本地防抖保存。 */
export function NoteEditor({ noteId, initialBody, onSave }: NoteEditorProps) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handleInput = (body: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void onSave(body), 400);
  };
  return (
    <textarea
      key={noteId}
      defaultValue={initialBody}
      onInput={(e) => handleInput((e.target as HTMLTextAreaElement).value)}
    />
  );
}
