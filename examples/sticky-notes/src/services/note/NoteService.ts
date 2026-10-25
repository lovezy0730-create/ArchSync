import type { NoteRecord } from './NoteRepository';

export interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
}

export interface Note extends NoteSummary {
  body: string;
  version: number;
  archived: boolean;
}

/** 笔记管理：创建、更新、归档。版本号由 NoteVersioning 维护。 */
export class NoteService {
  constructor(private repo: { get(id: string): NoteRecord | null; put(note: NoteRecord): void }) {}

  create(body: string): Note {
    const now = Date.now();
    const record: NoteRecord = {
      id: `note_${now.toString(36)}`,
      body,
      version: 1,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.put(record);
    return this.toNote(record);
  }

  toNote(r: NoteRecord): Note {
    const firstLine = r.body.split('\n', 1)[0] ?? '';
    return {
      id: r.id,
      title: firstLine.slice(0, 40),
      preview: r.body.slice(0, 80),
      updatedAt: r.updatedAt,
      body: r.body,
      version: r.version,
      archived: r.archived,
    };
  }
}
