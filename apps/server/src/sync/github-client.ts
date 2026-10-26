import type { CollabData } from '@archsync/contracts';
import type { LocalDatabase } from '../db.js';

export interface GithubApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  etag: string | null;
  /** rate limit bookkeeping from response headers */
  remaining: number | null;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  error?: string;
  errorKind?: 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'server' | 'network';
}

/**
 * GitHub REST client for the sync worker, with:
 * - conditional GET (If-None-Match) backed by the persisted ETag table
 * - 304 short-circuit (callers keep prior data, no event churn)
 * - global request budget shared by all projects (anonymous: 60/h, token: 5000/h)
 * - Retry-After / X-RateLimit-* honouring and a global cooldown period
 *
 * The token never appears in errors, logs or persisted payloads.
 */
export class GithubApiClient {
  private budget: { windowStart: number; used: number; max: number } = {
    windowStart: Date.now(),
    used: 0,
    max: 4800, // token budget; swapped to 55 by setAnonymousMode()
  };
  private cooldownUntil = 0;

  constructor(
    private readonly db: LocalDatabase,
    private readonly tokenProvider: () => string | null,
  ) {
    if (!this.tokenProvider()) this.budget.max = 55;
  }

  private rollBudgetWindow(now: number): void {
    if (now - this.budget.windowStart > 60 * 60 * 1000) {
      this.budget = { windowStart: now, used: 0, max: this.budget.max };
    }
  }

  hasBudget(): boolean {
    this.rollBudgetWindow(Date.now());
    return this.budget.used < this.budget.max && Date.now() > this.cooldownUntil;
  }

  budgetStatus(): { used: number; max: number; cooldownUntil: string | null; token: boolean } {
    this.rollBudgetWindow(Date.now());
    return {
      used: this.budget.used,
      max: this.budget.max,
      cooldownUntil: this.cooldownUntil > Date.now() ? new Date(this.cooldownUntil).toISOString() : null,
      token: this.tokenProvider() !== null,
    };
  }

  etagFor(cacheKey: string): string | null {
    const row = this.db.prepare('SELECT etag FROM github_etags WHERE cache_key = ?').get(cacheKey) as
      | { etag: string | null }
      | undefined;
    return row?.etag ?? null;
  }

  saveEtag(cacheKey: string, projectId: string, kind: string, etag: string | null, status: string): void {
    this.db
      .prepare(
        `INSERT INTO github_etags (cache_key, project_id, kind, etag, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET etag = excluded.etag, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(cacheKey, projectId, kind, etag, status, new Date().toISOString());
  }

  /** Read cached payload (used when ETag returns 304). */
  readCache<T>(projectId: string, kind: string): T | null {
    const row = this.db
      .prepare('SELECT payload_json FROM github_cache WHERE project_id = ? AND kind = ?')
      .get(projectId, kind) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as T;
    } catch {
      return null;
    }
  }

  writeCache(projectId: string, kind: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO github_cache (project_id, kind, payload_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, kind) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      )
      .run(projectId, kind, JSON.stringify(payload), new Date().toISOString());
  }

  async request<T>(
    projectId: string,
    kind: string,
    path: string,
    options: { conditional?: boolean } = {},
  ): Promise<GithubApiResult<T>> {
    this.rollBudgetWindow(Date.now());
    if (this.budget.used >= this.budget.max) {
      return {
        ok: false,
        status: 0,
        data: null,
        etag: null,
        remaining: null,
        resetAt: null,
        retryAfterSeconds: null,
        error: `请求预算耗尽（${this.budget.max}/小时）`,
        errorKind: 'rate_limited',
      };
    }
    if (Date.now() < this.cooldownUntil) {
      return {
        ok: false,
        status: 0,
        data: null,
        etag: null,
        remaining: null,
        resetAt: null,
        retryAfterSeconds: null,
        error: '全局冷却中（上一轮限流）',
        errorKind: 'rate_limited',
      };
    }

    const token = this.tokenProvider();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ArchSync-SyncWorker',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const cacheKey = `${projectId}:${kind}`;
    if (options.conditional !== false) {
      const etag = this.etagFor(cacheKey);
      if (etag) headers['If-None-Match'] = etag;
    }

    this.budget.used += 1;
    let res: Response;
    try {
      res = await fetch(`https://api.github.com${path}`, { headers });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        etag: null,
        remaining: null,
        resetAt: null,
        retryAfterSeconds: null,
        error: `网络请求失败: ${(err as Error).message}`,
        errorKind: 'network',
      };
    }

    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const resetEpoch = Number(res.headers.get('x-ratelimit-reset'));
    const resetAt = Number.isFinite(resetEpoch) && resetEpoch > 0 ? new Date(resetEpoch * 1000).toISOString() : null;
    const retryAfterRaw = res.headers.get('retry-after');
    const retryAfterSeconds = retryAfterRaw === null ? null : Number(retryAfterRaw);

    if (res.status === 304) {
      // not modified: keep prior cache, refresh the recorded etag status
      this.saveEtag(cacheKey, projectId, kind, this.etagFor(cacheKey), 'unchanged');
      const cached = this.readCache<T>(projectId, kind);
      return {
        ok: true,
        status: 304,
        data: cached,
        etag: res.headers.get('etag'),
        remaining: Number.isFinite(remaining) ? remaining : null,
        resetAt,
        retryAfterSeconds,
      };
    }

    if (res.status === 401) {
      return fail(res, 'auth', 'Token 无效或已过期（401）');
    }
    if (res.status === 403) {
      // primary or secondary rate limit; also plain permission denial
      const isRate = remaining === 0 || retryAfterSeconds !== null;
      if (isRate) {
        const wait = retryAfterSeconds ?? Math.max(60, Math.ceil(((resetEpoch * 1000 || 0) - Date.now()) / 1000));
        this.cooldownUntil = Date.now() + Math.min(wait, 15 * 60) * 1000;
        return fail(res, 'rate_limited', `限流：冷却 ${Math.min(wait, 900)}s`);
      }
      return fail(res, 'forbidden', '权限不足（403）');
    }
    if (res.status === 404) {
      return fail(res, 'not_found', '仓库或资源不存在（404）');
    }
    if (res.status === 429) {
      const wait = retryAfterSeconds ?? 120;
      this.cooldownUntil = Date.now() + Math.min(wait, 15 * 60) * 1000;
      return fail(res, 'rate_limited', `限流（429）：冷却 ${Math.min(wait, 900)}s`);
    }
    if (res.status >= 500) {
      return fail(res, 'server', `GitHub 服务端故障（${res.status}）`);
    }
    if (!res.ok) {
      return fail(res, 'server', `意外状态 ${res.status}`);
    }

    const etag = res.headers.get('etag');
    const data = (await res.json()) as T;
    this.writeCache(projectId, kind, data); // 304 path reads this back
    this.saveEtag(cacheKey, projectId, kind, etag, 'fresh');
    return {
      ok: true,
      status: 200,
      data,
      etag,
      remaining: Number.isFinite(remaining) ? remaining : null,
      resetAt,
      retryAfterSeconds,
    };

    function fail(
      response: Response,
      errorKind: NonNullable<GithubApiResult<unknown>['errorKind']>,
      message: string,
    ): GithubApiResult<T> {
      return {
        ok: false,
        status: response.status,
        data: null,
        etag: response.headers.get('etag'),
        remaining: Number.isFinite(remaining) ? remaining : null,
        resetAt,
        retryAfterSeconds,
        error: message,
        errorKind,
      };
    }
  }
}

/** Rebuild a CollabData from cached worker data (issues/pulls/commits). */
export function collabFromCache(cached: {
  issues?: CollabData['issues'];
  pullRequests?: CollabData['pullRequests'];
  fetchedAt?: string | null;
  error?: string | null;
}): CollabData | null {
  if (!cached || (cached.issues === undefined && cached.pullRequests === undefined)) return null;
  return {
    source: 'live',
    demo: false,
    fetchedAt: cached.fetchedAt ?? new Date().toISOString(),
    error: cached.error ?? null,
    team: [],
    issues: cached.issues ?? [],
    pullRequests: cached.pullRequests ?? [],
    moduleIssues: {},
    manualApprovals: {},
  };
}
