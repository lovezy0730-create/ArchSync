import chokidar from 'chokidar';
import type { ProjectEntry } from '../projects.js';

export interface WatcherCallbacks {
  onProjectChanged: (entry: ProjectEntry) => void;
}

const IGNORED = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.local/**',
  '**/coverage/**',
  '**/.next/**',
];

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
        return IGNORED.some((pattern) => {
          const seg = pattern.replace(/\*\*\//g, '').replace(/\/\*\*/g, '');
          return norm.split('/').some((s) => s === seg);
        });
      },
      ignoreInitial: true,
      persistent: true,
      depth: 12,
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
