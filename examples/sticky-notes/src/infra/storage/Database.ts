import type { NoteRecord } from '../../services/note/NoteRepository';

/** 极简内存表，接口对齐 SQLite 实现（WAL 模式与文件落盘见 Migrations）。 */
export class Database {
  private tables = new Map<string, Map<string, unknown>>();

  table<T>(name: string): Map<string, T> {
    const t = (this.tables.get(name) ?? new Map()) as Map<string, T>;
    this.tables.set(name, t);
    return t;
  }

  get notes(): Map<string, NoteRecord> {
    return this.table<NoteRecord>('notes');
  }
}
