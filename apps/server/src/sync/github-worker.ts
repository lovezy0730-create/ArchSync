import type { ProjectEntry } from '../projects.js';
import { matchPaths } from '@archsync/scanner';
import type { LocalDatabase } from '../db.js';
import { GithubApiClient } from './github-client.js';

/** A single deduplicated timeline event. */
export interface SyncEvent {
  projectId: string;
  source: 'github' | 'local' | 'agent';
  eventType: string;
  remoteId: string;
  title: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface RemoteChangeSummary {
  changed: boolean;
  events: SyncEvent[];
  headSha: string | null;
  errors: string[];
}

const MAX_FILES_PER_PR_TICK = 5;

/**
 * PR/Issue/Commit/Check state → timeline events. Dedup key includes a hash of
 * the relevant state so repeated polls never duplicate, but a real state
 * transition (open→merged etc.) produces a new event.
 */
export function recordEvents(db: LocalDatabase, events: SyncEvent[]): number {
  let inserted = 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO sync_events
     (project_id, source, event_type, remote_id, title, detail_json, occurred_at, recorded_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    const stateHash = simpleHash(JSON.stringify([event.eventType, event.title, event.detail]));
    const dedupeKey = `${event.projectId}:${event.source}:${event.eventType}:${event.remoteId}:${stateHash}`;
    const result = stmt.run(
      event.projectId,
      event.source,
      event.eventType,
      event.remoteId,
      event.title,
      JSON.stringify(event.detail),
      event.occurredAt,
      new Date().toISOString(),
      dedupeKey,
    );
    inserted += Number(result.changes);
  }
  return inserted;
}

function simpleHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Map changed file paths to module ids from the project config; ambiguous
 * files (matched by several modules) are reported per module honestly. */
export function mapFilesToModules(
  entry: ProjectEntry,
  files: string[],
): { moduleId: string; files: string[]; ambiguous: string[] }[] {
  const out = new Map<string, Set<string>>();
  for (const file of files) {
    const owners: string[] = [];
    for (const m of entry.config.modules) {
      if (m.paths.length > 0 && matchPaths(m.paths, [file]).length > 0) owners.push(m.id);
    }
    for (const owner of owners) {
      const set = out.get(owner) ?? new Set<string>();
      set.add(file);
      out.set(owner, set);
    }
  }
  return [...out.entries()].map(([moduleId, set]) => ({
    moduleId,
    files: [...set],
    ambiguous: [],
  }));
}

export interface WorkerCallbacks {
  /** fired when remote data actually changed; caller rebuilds the snapshot */
  onRemoteChanged: (entry: ProjectEntry) => void;
  log: (...a: unknown[]) => void;
}

interface PullSummary {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  user?: { login?: string };
  merged_at?: string | null;
  updated_at?: string;
  head?: { sha?: string };
}

interface IssueSummary {
  number: number;
  title: string;
  state: string;
  updated_at?: string;
  pull_request?: unknown;
  assignees?: Array<{ login?: string }>;
  labels?: Array<{ name?: string } | string>;
}

interface CommitSummary {
  sha: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
}

/**
 * GitHubSyncWorker: long-running poller for every monitored project.
 *
 * Design guarantees:
 * - never re-downloads whole repos; 3-6 budgeted requests per project tick
 * - ETag conditional GETs → 304 ticks cost one request and zero events
 * - a global budget is shared across projects; 403/429/Retry-After trigger a
 *   shared cooldown instead of unbounded retries
 * - events are deduplicated by (project, kind, remote id, state hash)
 * - remote state is kept separate from local overlay; nothing is deleted from
 *   prior caches on transient errors (stale > guessed)
 */
export class GithubSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private idleMultiplier = new Map<string, number>();
  private lastHeadSha = new Map<string, string>();
  private running = false;
  private readonly baseIntervalMs: number;
  private readonly minIntervalMs = 60 * 1000;
  private readonly maxIntervalMs = 15 * 60 * 1000;

  constructor(
    private readonly db: LocalDatabase,
    private readonly client: GithubApiClient,
    private readonly monitored: () => Array<{ entry: ProjectEntry; intervalSeconds: number }>,
    private readonly callbacks: WorkerCallbacks,
  ) {
    this.baseIntervalMs = 30_000; // scheduler granularity; per-project interval gates work
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.baseIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Immediate synchronous pass for one project (user-facing "立即同步"). */
  async syncNow(entry: ProjectEntry): Promise<RemoteChangeSummary> {
    this.idleMultiplier.set(entry.id, 1);
    return this.syncProject(entry);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    if (!this.client.hasBudget()) return;
    this.running = true;
    try {
      for (const { entry, intervalSeconds } of this.monitored()) {
        const idle = this.idleMultiplier.get(entry.id) ?? 1;
        const last = this.lastTickAt.get(entry.id);
        const dueMs = Math.max(this.minIntervalMs, intervalSeconds * 1000 * idle);
        if (last !== undefined && Date.now() - last < dueMs) continue;
        this.lastTickAt.set(entry.id, Date.now());
        if (!this.client.hasBudget()) break; // shared budget: leave some for others
        const summary = await this.syncProject(entry);
        if (summary.changed) {
          this.idleMultiplier.set(entry.id, 1); // active again
          this.callbacks.onRemoteChanged(entry);
        } else if (summary.errors.length === 0) {
          // quiet project: back off progressively up to the ceiling
          this.idleMultiplier.set(entry.id, Math.min(idle * 2, Math.ceil(this.maxIntervalMs / this.baseIntervalMs)));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private lastTickAt = new Map<string, number>();

  private async syncProject(entry: ProjectEntry): Promise<RemoteChangeSummary> {
    const { owner, repo } = entry.config.project.github;
    if (!owner || !repo) {
      return { changed: false, events: [], headSha: null, errors: ['项目未配置 GitHub owner/repo'] };
    }
    const projectId = entry.id;
    const events: SyncEvent[] = [];
    const errors: string[] = [];
    const base = `/repos/${owner}/${repo}`;
    let changed = false;

    /* 1. repo meta + head sha (cheap change detector) */
    const meta = await this.client.request<{ default_branch?: string; pushed_at?: string; updated_at?: string }>(
      projectId,
      'repo',
      base,
    );
    if (!meta.ok) {
      if (meta.errorKind === 'auth') errors.push(`${meta.error} —— 已停用该项目的远端同步`);
      else errors.push(meta.error ?? 'repo 查询失败');
      return { changed: false, events, headSha: this.lastHeadSha.get(projectId) ?? null, errors };
    }
    const headBranch = meta.data?.default_branch ?? entry.config.project.github.defaultBranch ?? 'main';

    /* 2. pulls (open, recent first) */
    const pulls = await this.client.request<PullSummary[]>(
      projectId,
      'pulls',
      `${base}/pulls?state=open&sort=updated&direction=desc&per_page=30`,
    );
    if (pulls.ok && pulls.data) {
      this.client.writeCache(projectId, 'pulls', pulls.data);
      const prevPulls = this.client.readCache<PullSummary[]>(projectId, 'pulls-previous') ?? [];
      const prevById = new Map(prevPulls.map((p) => [p.number, p]));
      for (const pr of pulls.data.slice(0, 20)) {
        const before = prevById.get(pr.number);
        const stateKey = pr.state;
        const mergedNow = pr.merged_at ?? null;
        if (before) {
          if (before.state === 'open' && mergedNow) {
            events.push(this.event(projectId, 'pr_merged', String(pr.number), `PR #${pr.number} 已合并：${pr.title}`, {
              url: `${base}/pull/${pr.number}`,
              mergedAt: mergedNow,
            }));
            changed = true;
          } else if (before.updated_at !== pr.updated_at) {
            events.push(this.event(projectId, 'pr_updated', String(pr.number), `PR #${pr.number} 有更新：${pr.title}`, {
              state: stateKey,
            }));
            changed = true;
          }
        } else {
          events.push(this.event(projectId, 'pr_opened', String(pr.number), `新 PR #${pr.number}：${pr.title}`, {
            state: stateKey,
            draft: Boolean(pr.draft),
            author: pr.user?.login ?? null,
          }));
          changed = true;
        }
      }
      this.client.writeCache(projectId, 'pulls-previous', pulls.data);
    } else if (pulls.error) {
      errors.push(pulls.error);
    }

    /* 3. issue state (updated since last poll via since= param) */
    const since = this.readSince(projectId);
    const issues = await this.client.request<IssueSummary[]>(
      projectId,
      'issues',
      `${base}/issues?state=all&sort=updated&direction=desc&per_page=30${since ? `&since=${encodeURIComponent(since)}` : ''}`,
    );
    if (issues.ok && issues.data) {
      const prevIssues = this.client.readCache<IssueSummary[]>(projectId, 'issues-previous') ?? [];
      const prevById = new Map(prevIssues.map((i) => [i.number, i]));
      for (const issue of issues.data.filter((i) => !i.pull_request).slice(0, 20)) {
        const before = prevById.get(issue.number);
        if (before) {
          if (before.state !== issue.state) {
            events.push(
              this.event(
                projectId,
                issue.state === 'open' ? 'issue_reopened' : 'issue_closed',
                String(issue.number),
                `Issue #${issue.number} ${issue.state === 'open' ? '重新打开' : '已关闭'}：${issue.title}`,
                { state: issue.state },
              ),
            );
            changed = true;
          } else if (before.updated_at !== issue.updated_at) {
            events.push(this.event(projectId, 'issue_updated', String(issue.number), `Issue #${issue.number} 有更新：${issue.title}`, {}));
            changed = true;
          }
        } else if (issue.state === 'open') {
          events.push(this.event(projectId, 'issue_opened', String(issue.number), `新 Issue #${issue.number}：${issue.title}`, {}));
          changed = true;
        }
      }
      this.client.writeCache(projectId, 'issues-previous', issues.data);
      this.writeSince(projectId, issues.data[0]?.updated_at ?? null);
    } else if (issues.error) {
      errors.push(issues.error);
    }

    /* 4. recent commits + CI status on head (only when head moved) */
    const commits = await this.client.request<CommitSummary[]>(
      projectId,
      'commits',
      `${base}/commits?sha=${encodeURIComponent(headBranch)}&per_page=10`,
    );
    if (commits.ok && commits.data && commits.data.length > 0) {
      const head = commits.data[0]!.sha;
      const prevHead = this.lastHeadSha.get(projectId);
      this.lastHeadSha.set(projectId, head);
      this.client.writeCache(projectId, 'head', { sha: head, branch: headBranch });
      if (prevHead && prevHead !== head) {
        changed = true;
        events.push(
          this.event(projectId, 'commit_pushed', head.slice(0, 10), `新提交 ${(commits.data[0]!.commit?.message ?? '').split('\n')[0]!.slice(0, 80)}`, {
            sha: head,
            author: commits.data[0]!.commit?.author?.name ?? null,
          }),
        );
      }
      if (prevHead !== head) {
        const status = await this.client.request<{ state?: string }>(
          projectId,
          'head-status',
          `${base}/commits/${head}/status`,
        );
        if (status.ok && status.data?.state && status.data.state !== 'unknown') {
          events.push(
            this.event(projectId, 'ci_status', head.slice(0, 10), `CI 状态：${status.data.state} @ ${head.slice(0, 8)}`, {
              state: status.data.state,
            }),
          );
        }
      }
    } else if (commits.error) {
      errors.push(commits.error);
    }

    /* 5. PR changed files → module mapping (budgeted per tick) */
    let filesBudget = MAX_FILES_PER_PR_TICK;
    for (const pr of (pulls.data ?? []).slice(0, 10)) {
      if (filesBudget <= 0) break;
      const cacheKind = `pr-files:${pr.number}`;
      const alreadyMapped = this.client.readCache<unknown>(projectId, cacheKind);
      const updatedSinceMapping = alreadyMapped === null;
      if (!updatedSinceMapping) continue;
      const filesRes = await this.client.request<Array<{ filename?: string; previous_filename?: string }>>(
        projectId,
        cacheKind,
        `${base}/pulls/${pr.number}/files?per_page=100`,
      );
      filesBudget -= 1;
      if (!filesRes.ok || !filesRes.data) {
        if (filesRes.errorKind === 'rate_limited') break;
        continue;
      }
      // 304 readback returns the cached object shape; live fetch returns an array
      const rawFiles: unknown = filesRes.data;
      const fileList: string[] = Array.isArray(rawFiles)
        ? (rawFiles as Array<{ filename?: string }>).map((f) => f.filename ?? '')
        : Array.isArray((rawFiles as { files?: string[] }).files)
          ? (rawFiles as { files: string[] }).files
          : [];
      if (fileList.length === 0) continue;
      const files = fileList.filter(Boolean);
      this.client.writeCache(projectId, cacheKind, { files, at: new Date().toISOString() });
      const mapping = mapFilesToModules(entry, files);
      const mappedFiles = new Set(mapping.flatMap((m) => m.files));
      const unmappedFiles = files.filter((f) => !mappedFiles.has(f));
      if (mapping.length > 0 || unmappedFiles.length > 0) {
        changed = true;
        events.push(
          this.event(projectId, 'pr_modules_mapped', String(pr.number), `PR #${pr.number} 影响模块：${mapping.map((m) => m.moduleId).join(', ') || '（无，文件均未归类）'}`, {
            modules: mapping.map((m) => m.moduleId),
            fileCount: files.length,
            sampleFiles: mapping.flatMap((m) => m.files).slice(0, 5),
            // files that belong to no module are shown as unclassified, never
            // silently assigned to a module (FR honesty)
            unmappedFiles: unmappedFiles.slice(0, 10),
          }),
        );
      }
    }

    const inserted = recordEvents(this.db, events);
    if (inserted > 0) this.callbacks.log(`[${entry.id}] ${inserted} 条新事件入时间线`);
    return { changed, events, headSha: this.lastHeadSha.get(projectId) ?? null, errors };
  }

  private readSince(projectId: string): string | null {
    const row = this.db.prepare('SELECT payload_json FROM github_cache WHERE project_id = ? AND kind = ?').get(
      projectId,
      'issues-since',
    ) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as string) : null;
  }

  private writeSince(projectId: string, value: string | null): void {
    if (!value) return;
    this.client.writeCache(projectId, 'issues-since', value);
  }

  private event(
    projectId: string,
    eventType: string,
    remoteId: string,
    title: string,
    detail: Record<string, unknown>,
  ): SyncEvent {
    return {
      projectId,
      source: 'github',
      eventType,
      remoteId,
      title,
      detail,
      occurredAt: new Date().toISOString(),
    };
  }
}
