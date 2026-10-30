import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// node:sqlite is an experimental builtin that bundler resolvers (vite/vitest)
// cannot resolve statically; process.getBuiltinModule bypasses that entirely.
const { DatabaseSync } = (
  process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
).getBuiltinModule?.('node:sqlite') as { DatabaseSync: typeof import('node:sqlite').DatabaseSync };

/**
 * SQLite persistence for the local agent (v1.1).
 *
 * Uses the built-in node:sqlite (no native build step). Migrations are
 * versioned and forward-only; user data is never dropped by an upgrade.
 * The legacy JSON state file remains the snapshot/annotation store — this
 * database adds the registry, sync cursors and the event timeline.
 */
export class LocalDatabase {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registry_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        local_path TEXT NOT NULL UNIQUE,
        owner TEXT,
        repo TEXT,
        default_branch TEXT,
        monitoring_enabled INTEGER NOT NULL DEFAULT 1,
        sync_interval_seconds INTEGER NOT NULL DEFAULT 120,
        last_scan_at TEXT,
        last_sync_at TEXT,
        last_error TEXT,
        snapshot_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_etags (
        cache_key TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        etag TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_cache (
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, kind)
      );
      CREATE TABLE IF NOT EXISTS sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        remote_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_events_project_time
        ON sync_events(project_id, occurred_at DESC);
    `);
    this.recordMigration(1);
    const columns = this.db.prepare('PRAGMA table_info(registry_projects)').all() as {name:string}[];
    if (!columns.some(c => c.name === 'kind')) {
      this.db.exec("ALTER TABLE registry_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'local' CHECK(kind IN ('local','remote-only')); UPDATE registry_projects SET kind = 'remote-only' WHERE local_path LIKE 'remote:%';");
    }
    this.recordMigration(2);
  }

  private recordMigration(version: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
