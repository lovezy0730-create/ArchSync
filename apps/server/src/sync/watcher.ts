import chokidar from 'chokidar';
import type { ProjectEntry } from '../projects.js';

export interface WatcherCallbacks {
  onProjectChanged: (entry: ProjectEntry) => void;
  /**
   * Directories that contain indexed source files. Watching only these (plus
   * the project root when the index is empty) avoids walking tens of
   * thousands of runtime/log files on startup.
   */
  sourceDirs?: (entryId: string) => string[] | null;
}

const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.local',
  'coverage',
  '.next',
  // Runtime/cache directories that churn constantly and never contain source.
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.cache',
  'logs',
  'Logs',
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
  private watchers: chokidar.FSWatcher[] = [];

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
    // One chokidar instance per root. A single watcher over nested roots makes
    // Windows ReadDirectoryChangesW drop events, and the polling fallback then
    // stats every file (tens of thousands in real repositories) every second,
    // which starves the event loop and makes rebuilds look hung. Per-root
    // native watches avoid both problems; polling remains opt-in
    // (ARCHSYNC_WATCH_POLLING=1).
    const usePolling = process.env.ARCHSYNC_WATCH_POLLING === '1';
    const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();
    const normalizedRoots = roots.map(normalize);
    const overlapping = normalizedRoots.some((root) =>
      normalizedRoots.some((other) => other !== root && (root.startsWith(`${other}/`) || other.startsWith(`${root}/`))),
    );
    const options = {
      ignoreInitial: true,
      persistent: true,
      depth: 14,
      usePolling,
      interval: usePolling ? 1500 : undefined,
      binaryInterval: usePolling ? 3000 : undefined,
    } as const;
    const ignored = (path: string) => {
      const norm = path.replace(/\\/g, '/');
      const entry = this.entryFor(norm);
      if (entry) return this.ignoreForRoot(entry.rootDir, path);
      return norm.split('/').some((s) => IGNORED_DIR_NAMES.has(s)) && !isGitStateSignal(norm);
    };
    const onEvent = (_event: string, file: string) => {
      const norm = file.replace(/\\/g, '/');
      const entry = this.entryFor(norm);
      if (!entry) return;
      // Only source/config changes can alter the index or the plan; runtime
      // logs and data files must not trigger a full rebuild.
      const relevant = /\.(tsx?|jsx?|mjs|cjs|py|json|ya?ml)$/i.test(norm) || isGitStateSignal(norm);
      if (!relevant) return;
      const existing = this.timers.get(entry.id);
      if (existing) clearTimeout(existing);
      this.timers.set(
        entry.id,
        setTimeout(() => {
          this.timers.delete(entry.id);
          this.callbacks.onProjectChanged(entry);
        }, this.debounceMs),
      );
    };
    const targets: { path: string; entryId: string }[] = [];
    for (const entry of this.entries) {
      if (!entry.rootDir) continue;
      const dirs = this.callbacks.sourceDirs?.(entry.id) ?? null;
      const paths = dirs && dirs.length > 0 ? dirs : [entry.rootDir];
      for (const path of paths) targets.push({ path, entryId: entry.id });
    }
    const uniqueTargets = [...new Map(targets.map((target) => [normalize(target.path), target])).values()];
    this.watchers = uniqueTargets.map((target) => {
      const watcher = chokidar.watch(target.path, { ...options, ignored });
      watcher.on('error', (err) => console.error('[watcher] 错误:', (err as Error).message ?? err));
      watcher.on('all', onEvent);
      return watcher;
    });
    console.log(`[watcher] 监听目标 ${this.watchers.length} 个目录（${usePolling ? 'polling' : 'fs.watch'}），根目录 ${roots.length} 个${overlapping ? '（存在重叠，独立监听）' : ''}`);
    Promise.all(this.watchers.map((watcher) => new Promise<void>((resolveReady) => watcher.once('ready', () => resolveReady()))))
      .then(() => console.log(`[watcher] 初始化完成（${usePolling ? 'polling' : 'fs.watch'} × ${roots.length}），正在监听 ${roots.length} 个根${overlapping ? '（根目录重叠，独立监听）' : ''}`))
      .catch(() => undefined);
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.all(this.watchers.map((watcher) => watcher.close().catch(() => undefined)));
    this.watchers = [];
  }
}
