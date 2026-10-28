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
    options: { conditional?: boolean; paginate?: boolean; maxPages?: number } = {},
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

    // Cache identity binds to the FULL canonical request (path + sorted query),
    // so `issues?since=A` and `issues?since=B` can never share an ETag slot.
    const [pathOnly, query = ''] = path.split('?');
    const canonicalQuery = query.split('&').filter(Boolean).sort().join('&');
    const cacheKey = `${projectId}:${kind}:${pathOnly}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    // 条件请求的三重门：etag 存在 + payload 缓存存在（否则 304 会拿到空数据）。
    // 判定必须先于 header 写入，否则 fallback 请求仍携带过期条件头。
    let conditional = options.conditional !== false;
    if (conditional) {
      const etag = this.etagFor(cacheKey);
      const hasPayload =
        this.readCache<unknown>(projectId, `${kind}:${canonicalQuery}`) !== null ||
        this.readCache<unknown>(projectId, kind) !== null;
      conditional = etag !== null && hasPayload;
    }
    if (conditional) {
      headers['If-None-Match'] = this.etagFor(cacheKey)!;
    }
    if (process.env.ARCHSYNC_CACHE_DEBUG) {
      console.log('[cache-debug]', cacheKey, 'conditional=', conditional);
    }

    this.budget.used += 1;
    let res: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        res = await fetch(`https://api.github.com${path}`, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      return {
        ok: false,
        status: 0,
        data: null,
        etag: null,
        remaining: null,
        resetAt: null,
        retryAfterSeconds: null,
        error: aborted ? '请求超时（30s）' : `网络请求失败: ${(err as Error).message}`,
        errorKind: 'network',
      };
    }

    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const resetEpoch = Number(res.headers.get('x-ratelimit-reset'));
    const resetAt = Number.isFinite(resetEpoch) && resetEpoch > 0 ? new Date(resetEpoch * 1000).toISOString() : null;
    const retryAfterRaw = res.headers.get('retry-after');
    const retryAfterSeconds = retryAfterRaw === null ? null : Number(retryAfterRaw);

    if (res.status === 304 && conditional) {
      // not modified: the payload cache must exist for this exact key; if it
      // does not (partial cache), fall through to an unconditional refetch
      const cached = this.readCache<T>(projectId, `${kind}:${canonicalQuery}`) ??
        this.readCache<T>(projectId, kind);
      if (cached !== null) {
        this.saveEtag(cacheKey, projectId, kind, this.etagFor(cacheKey), 'unchanged');
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

    // Link-header pagination: follow rel="next" up to maxPages, merging arrays.
    const firstPageData = (await res.json()) as T;
    if (options.paginate) {
      const maxPages = options.maxPages ?? 3;
      const collected: unknown[] = Array.isArray(firstPageData) ? (firstPageData as unknown[]) : [];
      let nextUrl: string | null = parseNextLink(res.headers.get('link'));
      let pages = 1;
      while (nextUrl && pages < maxPages) {
        this.budget.used += 1;
        if (this.budget.used >= this.budget.max) break;
        const pageRes = await fetch(nextUrl.startsWith('http') ? nextUrl : `https://api.github.com${nextUrl}`, {
          headers,
          signal: AbortSignal.timeout(30_000),
        });
        if (!pageRes.ok) break;
        const pageData = (await pageRes.json()) as unknown;
        if (!Array.isArray(pageData)) break;
        collected.push(...(pageData as unknown[]));
        nextUrl = parseNextLink(pageRes.headers.get('link'));
        pages += 1;
      }
      return {
        ok: true,
        status: 200,
        data: collected as T,
        etag: res.headers.get('etag'),
        remaining: Number.isFinite(remaining) ? remaining : null,
        resetAt,
        retryAfterSeconds,
      };
    }

    const data = firstPageData;
    const etag = res.headers.get('etag');
    this.writeCache(projectId, `${kind}:${canonicalQuery}`, data); // 304 readback, query-scoped
    this.writeCache(projectId, kind, data); // convenience: latest snapshot for the kind
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

/** Extract rel="next" from a GitHub Link header. */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** Rebuild a CollabData from cached worker data (issues/pulls/commits). */
export function collabFromCache(cached: {
  issues?: CollabData['issues'];
  pullRequests?: CollabData['pullRequests'];
  fetchedAt?: string | null;
  error?: string | null;
}): CollabData | null {
  if (!cached || (cached.issues === undefined && cached.pullRequests === undefined)) return null;
  // worker caches raw GitHub shapes; normalize to contract fields so downstream
  // consumers (changedFiles.some, checks comparisons) never see undefined
  const pullRequests: CollabData['pullRequests'] = (cached.pullRequests ?? []).map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft ?? false,
    author: p.author ?? 'unknown',
    assignees: p.assignees ?? [],
    headRef: p.headRef ?? '',
    mergedAt: p.mergedAt ?? null,
    closedAt: p.closedAt ?? null,
    createdAt: p.createdAt ?? '',
    updatedAt: p.updatedAt ?? '',
    changedFiles: p.changedFiles ?? [],
    checks: p.checks ?? 'unknown',
  }));
  const issues: CollabData['issues'] = (cached.issues ?? []).map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    assignees: i.assignees ?? [],
    labels: i.labels ?? [],
    author: i.author ?? 'unknown',
    createdAt: i.createdAt ?? '',
    updatedAt: i.updatedAt ?? '',
    closedAt: i.closedAt ?? null,
    completion: i.completion ?? 'none',
  }));
  return {
    source: 'live',
    demo: false,
    fetchedAt: cached.fetchedAt ?? new Date().toISOString(),
    error: cached.error ?? null,
    team: [],
    issues,
    pullRequests,
    moduleIssues: {},
    manualApprovals: {},
  };
}
