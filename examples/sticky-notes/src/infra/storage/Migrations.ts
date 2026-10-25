export interface Migration {
  version: number;
  name: string;
  up: (sql: (stmt: string) => void) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_notes',
    up: (sql) => {
      sql(
        'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
      );
      sql('CREATE INDEX idx_notes_updated ON notes(updated_at DESC)');
    },
  },
  {
    version: 2,
    name: 'create_settings',
    up: (sql) => {
      sql('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    },
  },
];

/** 迁移执行器：只前进，不回滚；记录已应用版本。 */
export function applyMigrations(
  migrations: Migration[],
  applied: number[],
  sql: (stmt: string) => void,
): number[] {
  const done = [...applied];
  for (const m of migrations.sort((a, b) => a.version - b.version)) {
    if (!done.includes(m.version)) {
      m.up(sql);
      done.push(m.version);
    }
  }
  return done;
}
