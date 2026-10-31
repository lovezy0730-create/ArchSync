import chokidar from 'chokidar';
import type { ProjectEntry } from '../projects.js';

export interface WatcherCallbacks {
  onProjectChanged: (entry: ProjectEntry) => void;
}

const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.local',
  'coverage',
  '.next',
]);

/**
 * `.git` is watched selectively: HEAD/index/refs change on commit, stage and
 * branch switch, which alters the uncommitted overlay even though no source
 * file changed. Everything else under `.git` is ignored (objects churn etc.).
 */
function isGitStateSignal(normPath: string): boolean {
  const segments = normPath.split('/');
  const dotGit = segments.indexOf('.git');
  if (dotGit === -1) return false;
  const rel = segments.slice(dotGit + 1).join('/');
  return rel === 'HEAD' || rel === 'index' || rel.startsWith('refs/');
}

/**
 * Local file watcher (FR-07): watches every project's workspace, debounces
 * bursts, and triggers a snapshot rebuild per project. Watcher events only
 * ever rebuild the *local* snapshot — they never claim to be GitHub main.
 */
export class WorkspaceWatcher {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: chokidar.FSWatcher | null = null;

  constructor(
    private readonly entries: ProjectEntry[],
    private readonly callbacks: WatcherCallbacks,
    private readonly debounceMs: number,
  ) {}

  /** Most-specific root wins: an outer repo's root can be an ancestor of an
   * inner project's root (workspace root + registered sub-repos), and naive
   * find() would attribute inner files to the outer project. */
  private entryFor(normPath: string): ProjectEntry | null {
    const candidates = this.entries.filter((e) => {
      const rootNorm = e.rootDir.replace(/\\/g, '/');
      return normPath === rootNorm || normPath.startsWith(rootNorm + '/');
    });
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => b.rootDir.length - a.rootDir.length)[0]!;
  }

  /** Ignore rules evaluated against the path RELATIVE to the project root, so
   * an external repo living under .local/ (or any noisy ancestor) is still
   * monitored correctly. The watch root itself is never ignored. */
  private ignoreForRoot(rootDir: string, absPath: string): boolean {
    const norm = absPath.replace(/\\/g, '/');
    const rootNorm = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === rootNorm) return false;
    const rel = norm.startsWith(rootNorm + '/') ? norm.slice(rootNorm.length + 1) : null;
    if (rel === null) {
      return norm.split('/').some((s) => IGNORED_DIR_NAMES.has(s)) && !isGitStateSignal(norm);
    }
    const segments = rel.split('/');
    if (segments.some((s) => IGNORED_DIR_NAMES.has(s))) {
      return !isGitStateSignal(norm);
    }
    return false;
  }

  start(): void {
    const roots = [...new Set(this.entries.filter(e => e.rootDir).map((e) => e.rootDir))];
    // Windows fs.watch (ReadDirectoryChangesW) can silently drop events when
    // multiple nested watch roots overlap (workspace root + registered
    // sub-repos). Polling is the reliable default there; other platforms keep
    // the efficient fs.watch unless polling is explicitly requested.
    const usePolling =
      process.env.ARCHSYNC_WATCH_POLLING === '1' ||
      (process.platform === 'win32' && process.env.ARCHSYNC_WATCH_POLLING !== '0');
    this.watcher = chokidar.watch(roots, {
      ignored: (path: string) => {
        const norm = path.replace(/\\/g, '/');
        const entry = this.entryFor(norm);
        if (entry) return this.ignoreForRoot(entry.rootDir, path);
        return norm.split('/').some((s) => IGNORED_DIR_NAMES.has(s)) && !isGitStateSignal(norm);
      },
      ignoreInitial: true,
      persistent: true,
      depth: 14,
      // Windows fs.watch can silently drop events for nested watch roots;
      // polling is the reliable fallback (ARCHSYNC_WATCH_POLLING=1).
      usePolling,
      interval: usePolling ? 800 : undefined,
      binaryInterval: usePolling ? 2000 : undefined,
    });
    this.watcher.on('ready', () => {
      console.log(`[watcher] 初始化完成（${usePolling ? 'polling' : 'fs.watch'}），正在监听 ${roots.length} 个根`);
    });
    this.watcher.on('error', (err) => {
      console.error('[watcher] 错误:', err.message ?? err);
    });
    this.watcher.on('all', (_event, file) => {
      const norm = file.replace(/\\/g, '/');
      const entry = this.entryFor(norm);
      if (!entry) return;
      const existing = this.timers.get(entry.id);
      if (existing) clearTimeout(existing);
      this.timers.set(
        entry.id,
        setTimeout(() => {
          this.timers.delete(entry.id);
          this.callbacks.onProjectChanged(entry);
        }, this.debounceMs),
      );
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }
}
