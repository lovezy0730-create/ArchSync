export interface NoteRecord {
  id: string;
  body: string;
  version: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 笔记持久化仓储接口；实现位于 infra/storage。 */
export interface NoteRepository {
  get(id: string): NoteRecord | null;
  list(): NoteRecord[];
  put(record: NoteRecord): void;
  delete(id: string): boolean;
}
