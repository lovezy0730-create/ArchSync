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

  start(): void {
    const roots = [...new Set(this.entries.map((e) => e.rootDir))];
    this.watcher = chokidar.watch(roots, {
      ignored: (path: string) => {
        const norm = path.replace(/\\/g, '/');
        const segments = norm.split('/');
        if (segments.some((s) => IGNORED_DIR_NAMES.has(s))) {
          return !isGitStateSignal(norm);
        }
        return false;
      },
      ignoreInitial: true,
      persistent: true,
      depth: 14,
    });
    this.watcher.on('all', (_event, file) => {
      const norm = file.replace(/\\/g, '/');
      const entry = this.entries.find((e) => norm.startsWith(e.rootDir.replace(/\\/g, '/')));
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
