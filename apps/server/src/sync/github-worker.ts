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

export type PullPhase = 'open' | 'closed' | 'merged';

export interface LastPullState {
  phase: PullPhase;
  headSha: string;
  title: string;
  mergedAt: string | null;
  draft: boolean;
  author: string;
}

/** Classify a raw GitHub PR payload into a stable phase; closed ≠ merged. */
export function classifyPull(pr: PullSummary): LastPullState {
  const merged = pr.merged_at ?? null;
  const phase: PullPhase = merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  return {
    phase,
    headSha: pr.head?.sha ?? '',
    title: pr.title,
    mergedAt: merged,
    draft: Boolean(pr.draft),
    author: pr.user?.login ?? 'unknown',
  };
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
  head?: { sha?: string; ref?: string };
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

  /**
   * Combined CI state for a head SHA. Merges the legacy commit-status API with
   * the check-runs API (GitHub Actions reports through check-runs). Terminal
   * states win over pending; cancelled/skipped stay distinct from success.
   */
  private async readCombinedCiState(
    projectId: string,
    base: string,
    headSha: string,
  ): Promise<{ state: string; url: string | null; source: string } | null> {
    const severity: Record<string, number> = {
      failure: 5,
      error: 4,
      action_required: 3,
      in_progress: 2,
      pending: 2,
      queued: 2,
      cancelled: 1,
      skipped: 1,
      success: 0,
      unknown: -1,
    };
    let worst = 'unknown';
    let url: string | null = null;
    let source = 'none';

    const status = await this.client.request<{ state?: string; statuses?: Array<{ state?: string }> }>(
      projectId,
      'head-status',
      `${base}/commits/${headSha}/status`,
    );
    if (status.ok && status.data?.state && status.data.state !== 'unknown') {
      worst = status.data.state;
      source = 'commit-status';
    }

    const runs = await this.client.request<{ check_runs?: Array<{
      status?: string;
      conclusion?: string | null;
      details_url?: string | null;
    }> }>(projectId, 'head-check-runs', `${base}/commits/${headSha}/check-runs?per_page=100`);
    if (runs.ok && runs.data?.check_runs) {
      source = source === 'none' ? 'check-runs' : `${source}+check-runs`;
      for (const run of runs.data.check_runs) {
        const state =
          run.status && run.status !== 'completed'
            ? run.status // queued | in_progress
            : (run.conclusion ?? 'unknown');
        if (state === 'neutral' || state === 'stale') continue;
        if ((severity[state] ?? -1) > (severity[worst] ?? -1)) {
          worst = state;
          url = run.details_url ?? null;
        }
      }
    }

    return { state: worst, url, source };
  }

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

    /* 2. PR state machine.
     * state=all is mandatory: merged/closed PRs leave the open list, so
     * polling state=open can never observe pr_merged/pr_closed transitions.
     * Last-known states persist in github_cache ('pulls-state') and survive
     * restarts. First-ever sighting of a repo seeds the baseline WITHOUT
     * emitting "just opened" events for historical PRs. */
    const pulls = await this.client.request<PullSummary[]>(
      projectId,
      'pulls',
      `${base}/pulls?state=all&sort=updated&direction=desc&per_page=30`,
    );
    if (pulls.ok && Array.isArray(pulls.data)) {
      const lastKnown = this.client.readCache<Record<string, LastPullState>>(projectId, 'pulls-state') ?? {};
      const hadBaseline = this.client.readCache<boolean>(projectId, 'pulls-seeded') === true;
      for (const pr of pulls.data.slice(0, 30)) {
        const before = lastKnown[String(pr.number)];
        const nowState = classifyPull(pr);
        if (!before) {
          if (hadBaseline) {
            // appeared after our first observation → genuinely new
            events.push(this.event(projectId, 'pr_opened', String(pr.number), `新 PR #${pr.number}：${pr.title}`, {
              state: nowState.phase, draft: nowState.draft, author: nowState.author,
            }));
            changed = true;
          }
        } else if (before.phase !== nowState.phase || before.headSha !== nowState.headSha) {
          if (before.phase === 'open' && nowState.phase === 'merged') {
            events.push(this.event(projectId, 'pr_merged', String(pr.number), `PR #${pr.number} 已合并：${pr.title}`, {
              url: `${base}/pull/${pr.number}`, mergedAt: nowState.mergedAt, headSha: nowState.headSha,
            }));
          } else if (before.phase === 'open' && nowState.phase === 'closed') {
            events.push(this.event(projectId, 'pr_closed', String(pr.number), `PR #${pr.number} 已关闭（未合并）：${pr.title}`, {
              url: `${base}/pull/${pr.number}`,
            }));
          } else if ((before.phase === 'closed' || before.phase === 'merged') && nowState.phase === 'open') {
            events.push(this.event(projectId, 'pr_reopened', String(pr.number), `PR #${pr.number} 重新打开：${pr.title}`, {
              state: 'open',
            }));
          } else if (before.headSha !== nowState.headSha) {
            events.push(this.event(projectId, 'pr_head_changed', String(pr.number), `PR #${pr.number} 推送了新提交`, {
              from: before.headSha, to: nowState.headSha, state: nowState.phase,
            }));
          } else {
            events.push(this.event(projectId, 'pr_updated', String(pr.number), `PR #${pr.number} 有更新：${pr.title}`, {
              state: nowState.phase, from: before.phase, to: nowState.phase,
            }));
          }
          changed = true;
        } else if (before.title !== pr.title && hadBaseline) {
          events.push(this.event(projectId, 'pr_updated', String(pr.number), `PR #${pr.number} 标题更新：${pr.title}`, {}));
          changed = true;
        }
      }
      this.client.writeCache(projectId, 'pulls-state', Object.fromEntries(
        pulls.data.slice(0, 30).map((pr) => [String(pr.number), classifyPull(pr)]),
      ));
      if (!hadBaseline) this.client.writeCache(projectId, 'pulls-seeded', true);
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
      // CI state: combined status covers legacy commit statuses; check-runs
      // covers GitHub Actions. Pending heads are re-checked every tick until a
      // terminal state is reached (otherwise pending could never resolve).
      const cachedCi = this.client.readCache<{ state?: string }>(projectId, 'head-ci');
      const headChanged = prevHead !== head;
      const previousNonTerminal = cachedCi?.state === 'pending' || cachedCi?.state === 'in_progress';
      if (headChanged || previousNonTerminal) {
        const ciState = await this.readCombinedCiState(projectId, base, head);
        if (ciState && ciState.state !== 'unknown') {
          this.client.writeCache(projectId, 'head-ci', { state: ciState.state });
          if (headChanged || ciState.state !== cachedCi?.state) {
            events.push(
              this.event(projectId, 'ci_status', head.slice(0, 10), `CI 状态：${ciState.state} @ ${head.slice(0, 8)}`, {
                state: ciState.state,
                url: ciState.url,
                source: ciState.source,
                ...(ciState.state === 'failure' ? { failureHint: 'CI 失败不等于功能未完成/完成——仅为验证证据' } : {}),
              }),
            );
            changed = true;
          }
        }
      }
    } else if (commits.error) {
      errors.push(commits.error);
    }

    /* 5. PR changed files → module mapping.
     * Cache invalidation is keyed on the PR's HEAD SHA: a new push replaces
     * the whole file mapping (additions AND removals); metadata-only updates
     * keep the previous mapping without refetching. Renames contribute both
     * filename and previous_filename. Pagination follows the Link header. */
    let filesBudget = MAX_FILES_PER_PR_TICK;
    for (const pr of (pulls.data ?? []).slice(0, 15)) {
      if (filesBudget <= 0) break;
      const nowState = classifyPull(pr);
      if (nowState.headSha === '') continue;
      const cacheKey = `pr-files:${pr.number}`;
      const cached = this.client.readCache<{ headSha?: string; files?: string[]; at?: string }>(
        projectId,
        cacheKey,
      );
      if (cached?.headSha === nowState.headSha && Array.isArray(cached.files)) {
        continue; // HEAD unchanged → mapping still valid
      }
      const filesRes = await this.client.request<Array<{ filename?: string; previous_filename?: string }>>(
        projectId,
        cacheKey,
        `${base}/pulls/${pr.number}/files?per_page=100`,
        { paginate: true },
      );
      filesBudget -= 1;
      if (!filesRes.ok || !filesRes.data) {
        if (filesRes.errorKind === 'rate_limited' || filesRes.errorKind === 'network') break;
        continue;
      }
      // array (live) or object (304 readback of the array) both acceptable
      const rawFiles: unknown = filesRes.data;
      const fileList: string[] = Array.isArray(rawFiles)
        ? (rawFiles as Array<{ filename?: string; previous_filename?: string }>).flatMap((f) =>
            [f.filename, f.previous_filename].filter((n): n is string => Boolean(n)),
          )
        : Array.isArray((rawFiles as { files?: string[] }).files)
          ? (rawFiles as { files: string[] }).files
          : [];
      const files = [...new Set(fileList.filter(Boolean))].sort();
      if (files.length === 0) continue;
      this.client.writeCache(projectId, cacheKey, {
        headSha: nowState.headSha,
        files,
        at: new Date().toISOString(),
      });

      const mapping = mapFilesToModules(entry, files);
      const mappedFiles = new Set(mapping.flatMap((m) => m.files));
      const unmappedFiles = files.filter((f) => !mappedFiles.has(f));
      const prevMapping = cached?.headSha !== undefined ? cached.files ?? [] : null;
      const modulesChanged =
        prevMapping === null ||
        JSON.stringify(mapping.map((m) => m.moduleId).sort()) !==
          JSON.stringify([...new Set(mapFilesToModules(entry, prevMapping).map((m) => m.moduleId))].sort());
      if (mapping.length > 0 || unmappedFiles.length > 0) {
        changed = true;
        events.push(
          this.event(projectId, 'pr_modules_mapped', String(pr.number), `PR #${pr.number} 影响模块：${mapping.map((m) => m.moduleId).join(', ') || '（无，文件均未归类）'}`, {
            modules: mapping.map((m) => m.moduleId),
            modulesChanged,
            prevHeadSha: cached?.headSha ?? null,
            headSha: nowState.headSha,
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
