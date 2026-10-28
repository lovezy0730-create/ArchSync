import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfigFile } from '@archsync/contracts';
import { parseProjectConfig } from '@archsync/config';
import { loadEntry, type ProjectEntry } from './projects.js';
import type { LocalDatabase } from './db.js';

const execFileAsync = promisify(execFile);

/** Row shape mirrored from the registry_projects table. */
export interface RegistryProject {
  id: string;
  name: string;
  localPath: string;
  owner: string | null;
  repo: string | null;
  defaultBranch: string | null;
  monitoringEnabled: boolean;
  syncIntervalSeconds: number;
  lastScanAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  snapshotVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface GitRepoFacts {
  isGitRepo: true;
  /** worktrees carry a `.git` FILE pointing at the real dir — both supported */
  gitKind: 'dir' | 'file';
  branch: string | null;
  headSha: string | null;
  remoteOriginUrl: string | null;
}

export interface AddLocalResult {
  ok: boolean;
  error?: string;
  /** set when the repo has no .archsync/project.yaml yet — caller runs the wizard */
  needsInit?: boolean;
  initSuggestion?: { totalFiles: number; modules: number; sampleDirs: string[] };
  project?: RegistryProject & { entry: ProjectEntry };
}

const GIT_TIMEOUT_MS = 20_000;

async function git(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: rootDir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Inspect a local directory for Git facts; supports worktrees (.git file). */
export async function inspectGitRepo(rawPath: string): Promise<
  { ok: true; facts: GitRepoFacts; absPath: string } | { ok: false; error: string }
> {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { ok: false, error: '路径不能为空' };
  }
  const absPath = resolve(rawPath.trim());
  if (!isAbsolute(absPath)) return { ok: false, error: '必须是绝对路径' };
  if (!existsSync(absPath)) return { ok: false, error: `目录不存在: ${absPath}` };
  if (!statSync(absPath).isDirectory()) return { ok: false, error: '路径不是目录' };

  const dotGit = join(absPath, '.git');
  if (!existsSync(dotGit)) {
    return { ok: false, error: `${absPath} 不是 Git 仓库（缺少 .git）` };
  }
  const gitKind = statSync(dotGit).isDirectory() ? 'dir' : 'file';
  let branch: string | null = null;
  let headSha: string | null = null;
  let remoteOriginUrl: string | null = null;
  try {
    branch = (await git(absPath, ['branch', '--show-current'])).trim() || null;
    headSha = (await git(absPath, ['rev-parse', 'HEAD'])).trim() || null;
    try {
      remoteOriginUrl = (await git(absPath, ['remote', 'get-url', 'origin'])).trim() || null;
    } catch {
      remoteOriginUrl = null; // no origin configured
    }
  } catch (err) {
    return { ok: false, error: `git 命令失败: ${(err as Error).message}` };
  }
  return { ok: true, facts: { isGitRepo: true, gitKind, branch, headSha, remoteOriginUrl }, absPath };
}

function parseOwnerRepo(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const https = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  return null;
}

/**
 * Project registry: SQLite-backed multi-repo management. The live ProjectEntry
 * map is shared with the routes/runtime by reference so dynamic add/remove
 * takes effect immediately without restarts.
 */
export class ProjectRegistry {
  constructor(
    private readonly db: LocalDatabase,
    /** live project entries consumed by routes/watcher/snapshot pipeline */
    public readonly liveEntries: Map<string, ProjectEntry>,
    private readonly onRegistryChanged: (event: 'added' | 'removed' | 'enabled' | 'disabled') => void,
  ) {}

  list(): RegistryProject[] {
    const rows = this.db
      .prepare('SELECT * FROM registry_projects ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToProject);
  }

  get(id: string): RegistryProject | null {
    const row = this.db.prepare('SELECT * FROM registry_projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProject(row) : null;
  }

  findByPath(absPath: string): RegistryProject | null {
    const normalized = absPath.replace(/\\/g, '/').toLowerCase();
    for (const p of this.list()) {
      if (p.localPath.replace(/\\/g, '/').toLowerCase() === normalized) return p;
    }
    return null;
  }

  /**
   * Register an existing local repository. Validates git facts, loads or
   * flags a missing project.yaml, and never touches the user's files.
   */
  async addLocal(rawPath: string): Promise<AddLocalResult> {
    const inspected = await inspectGitRepo(rawPath);
    if (!inspected.ok) return { ok: false, error: inspected.error };
    const { facts, absPath } = inspected;

    if (this.findByPath(absPath)) {
      return { ok: false, error: `该路径已注册: ${absPath}` };
    }

    const configPath = join(absPath, '.archsync', 'project.yaml');
    let configText: string;
    if (existsSync(configPath)) {
      configText = readFileSync(configPath, 'utf8');
    } else {
      return {
        ok: false,
        needsInit: true,
        initSuggestion: this.quickScan(absPath),
        error: `${absPath} 没有 .archsync/project.yaml —— 可用 pnpm archsync:init 生成后再添加，或在下方使用初始化建议`,
      };
    }
    const parsed = parseProjectConfig(configText);
    if (!parsed.ok || !parsed.config) {
      const first = parsed.errors[0];
      return { ok: false, error: `project.yaml 无效: ${first?.message ?? '未知错误'}` };
    }

    const entry = loadEntry(join(absPath, '.archsync', 'project.yaml'));
    if ('error' in entry) return { ok: false, error: entry.error };

    const ownerRepo = parseOwnerRepo(facts.remoteOriginUrl);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO registry_projects
         (id, name, local_path, owner, repo, default_branch, monitoring_enabled,
          sync_interval_seconds, last_scan_at, last_sync_at, last_error, snapshot_version,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 120, NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        entry.id,
        entry.name,
        absPath,
        ownerRepo?.owner ?? null,
        ownerRepo?.repo ?? null,
        facts.branch ?? entry.config.project.github.defaultBranch ?? 'main',
        now,
        now,
      );

    this.liveEntries.set(entry.id, entry);
    this.onRegistryChanged('added');
    return { ok: true, project: { ...this.get(entry.id)!, entry } };
  }

  /** Lightweight structure scan for the init hint (no file contents). */
  private quickScan(rootDir: string): AddLocalResult['initSuggestion'] {
    try {
      const seen = new Map<string, number>();
      const walk = (dir: string, depth: number): void => {
        if (depth > 3) return;
        for (const name of readdirSafe(dir)) {
          if (['node_modules', '.git', 'dist', 'build', '.local', 'coverage'].includes(name)) continue;
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full, depth + 1);
          else if (/\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(name)) {
            const rel = full.slice(rootDir.length + 1).replace(/\\/g, '/');
            const top = rel.split('/').slice(0, rel.startsWith('src/') ? 2 : 1).join('/');
            seen.set(top, (seen.get(top) ?? 0) + 1);
          }
        }
      };
      walk(rootDir, 0);
      const dirs = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      return {
        totalFiles: [...seen.values()].reduce((a, b) => a + b, 0),
        modules: dirs.length,
        sampleDirs: dirs.map(([d, n]) => `${d} (${n} 文件)`),
      };
    } catch {
      return { totalFiles: 0, modules: 0, sampleDirs: [] };
    }
  }

  /** Add by GitHub owner/repo: remote-only analysis (no clone) — read-only. */
  async addGithubRemote(
    owner: string,
    repo: string,
    _opts: { token?: string | null } = {},
  ): Promise<{ ok: boolean; error?: string; remoteOnly?: boolean; facts?: Record<string, unknown> }> {
    // Remote-only mode cannot observe unpushed local changes; that limitation
    // is surfaced to the caller and displayed in the UI.
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ArchSync-Registry' },
      });
      if (!res.ok) {
        return {
          ok: false,
          error:
            res.status === 404
              ? `${owner}/${repo} 不存在或不可访问（私有仓库需要本地克隆 + 授权接入）`
              : `GitHub 查询失败: HTTP ${res.status}`,
        };
      }
      const meta = (await res.json()) as {
        default_branch?: string;
        language?: string;
        private?: boolean;
        html_url?: string;
      };
      return {
        ok: true,
        remoteOnly: true,
        facts: {
          defaultBranch: meta.default_branch ?? 'main',
          language: meta.language ?? 'unknown',
          isPrivate: Boolean(meta.private),
          url: meta.html_url,
          note: '仅远端只读分析：无法观察未推送的本地修改；生成架构需先克隆到本地并添加为本地项目',
        },
      };
    } catch (err) {
      return { ok: false, error: `GitHub 网络请求失败: ${(err as Error).message}` };
    }
  }

  setMonitoring(id: string, enabled: boolean): RegistryProject | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db
      .prepare('UPDATE registry_projects SET monitoring_enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    this.onRegistryChanged(enabled ? 'enabled' : 'disabled');
    return this.get(id);
  }

  /** Remove from the registry and live set. NEVER deletes user source code. */
  remove(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.db.prepare('DELETE FROM registry_projects WHERE id = ?').run(id);
    this.liveEntries.delete(id);
    this.onRegistryChanged('removed');
    return true;
  }

  markScan(id: string, snapshotVersion: number, error: string | null = null): void {
    this.db
      .prepare(
        'UPDATE registry_projects SET last_scan_at = ?, snapshot_version = ?, last_error = ?, updated_at = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), snapshotVersion, error, new Date().toISOString(), id);
  }

  markSync(id: string, error: string | null = null): void {
    this.db
      .prepare('UPDATE registry_projects SET last_sync_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), error, new Date().toISOString(), id);
  }

  /** Reload an entry from disk (e.g. after project.yaml edits). */
  reloadEntry(id: string): ProjectEntry | null {
    const registered = this.get(id);
    if (!registered) return null;
    const entry = loadEntry(join(registered.localPath, '.archsync', 'project.yaml'));
    if ('error' in entry) return null;
    this.liveEntries.set(id, entry);
    return entry;
  }

  /** Seed built-in discovery projects (repo self + examples) idempotently. */
  seedFromDiscovery(
    entries: ProjectEntry[],
    skipped: string[],
    log: (...a: unknown[]) => void,
  ): void {
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (this.get(entry.id)) continue;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO registry_projects
           (id, name, local_path, owner, repo, default_branch, monitoring_enabled,
            sync_interval_seconds, last_scan_at, last_sync_at, last_error, snapshot_version,
            created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, NULL, 1, 120, NULL, NULL, NULL, 0, ?, ?)`,
        )
        .run(entry.id, entry.name, entry.rootDir, now, now);
      this.liveEntries.set(entry.id, entry);
      log(`注册项目: ${entry.name} (${entry.id})`);
    }
    for (const reason of skipped) log('跳过项目:', reason);
  }

  /** Entries currently eligible for monitoring. */
  monitoredEntries(): Array<{ entry: ProjectEntry; intervalSeconds: number }> {
    const out: Array<{ entry: ProjectEntry; intervalSeconds: number }> = [];
    for (const p of this.list()) {
      if (!p.monitoringEnabled) continue;
      const entry = this.liveEntries.get(p.id);
      if (entry) out.push({ entry, intervalSeconds: p.syncIntervalSeconds });
    }
    return out;
  }

  configFor(id: string): ProjectConfigFile | null {
    return this.liveEntries.get(id)?.config ?? null;
  }
}

function rowToProject(row: Record<string, unknown>): RegistryProject {
  return {
    id: String(row.id),
    name: String(row.name),
    localPath: String(row.local_path),
    owner: row.owner === null ? null : String(row.owner),
    repo: row.repo === null ? null : String(row.repo),
    defaultBranch: row.default_branch === null ? null : String(row.default_branch),
    monitoringEnabled: Number(row.monitoring_enabled) === 1,
    syncIntervalSeconds: Number(row.sync_interval_seconds),
    lastScanAt: row.last_scan_at === null ? null : String(row.last_scan_at),
    lastSyncAt: row.last_sync_at === null ? null : String(row.last_sync_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    snapshotVersion: Number(row.snapshot_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
