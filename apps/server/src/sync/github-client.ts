import { CollabDataSchema, type CollabData } from '@archsync/contracts';
import type { LocalDatabase } from '../db.js';

export interface GithubApiResult<T> {
  ok: boolean;
  completeness?: 'complete' | 'partial';
  status: number;
  data: T | null;
  etag: string | null;
  /** rate limit bookkeeping from response headers */
  remaining: number | null;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  error?: string;
  errorKind?: 'bad_request' | 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'server' | 'network' | 'timeout';
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
    options: { conditional?: boolean; paginate?: boolean; maxPages?: number; itemsKey?: string } = {},
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
    const initial = trustedGithubUrl(path);
    const [pathOnly, query = ''] = (initial.pathname + initial.search).split('?');
    const canonicalQuery = query.split('&').filter(Boolean).sort().join('&');
    const cacheKey = `${projectId}:${kind}:${pathOnly}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    // 条件请求的三重门：etag 存在 + payload 缓存存在（否则 304 会拿到空数据）。
    // 判定必须先于 header 写入，否则 fallback 请求仍携带过期条件头。
    const payloadKind = `request:${cacheKey}:${options.paginate ? 'all' : 'one'}:${options.itemsKey ?? ''}`;
    let conditional = options.conditional !== false;
    if (conditional) {
      const etag = this.etagFor(cacheKey);
      const hasPayload = this.readCache<unknown>(projectId, payloadKind) !== null;
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
        res = await fetch(initial.href, { headers, redirect: 'error', signal: controller.signal });
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
        error: aborted ? '请求超时（30s）' : '网络请求失败，请检查网络连接',
        errorKind: aborted ? 'timeout' : 'network',
      };
    }

    const remainingHeader = res.headers.get('x-ratelimit-remaining');
    const remaining = remainingHeader === null ? null : Number(remainingHeader);
    const resetEpoch = Number(res.headers.get('x-ratelimit-reset'));
    const resetAt = Number.isFinite(resetEpoch) && resetEpoch > 0 ? new Date(resetEpoch * 1000).toISOString() : null;
    const retryAfterRaw = res.headers.get('retry-after');
    const retryAfterSeconds = retryAfterRaw === null ? null : Number(retryAfterRaw);

    if (res.status === 304 && conditional) {
      // not modified: the payload cache must exist for this exact key; if it
      // does not (partial cache), fall through to an unconditional refetch
      const cached = this.readCache<T>(projectId, payloadKind);
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

    if (res.status === 304 && options.conditional !== false) return this.request<T>(projectId, kind, path, { ...options, conditional: false });

    if (res.status === 400) {
      return fail(res, 'bad_request', 'GitHub 请求参数无效（400）');
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
    let firstPageData: T;
    try { firstPageData = await res.json() as T; } catch { return fail(res, 'server', '无效 JSON'); }
    if (options.paginate) {
      const maxPages = options.maxPages ?? 100;
      const items = options.itemsKey ? (firstPageData as Record<string,unknown>)[options.itemsKey] : firstPageData;
      if (!Array.isArray(items)) return fail(res, 'server', '分页响应必须包含数组');
      const collected: unknown[] = [...items];
      let nextUrl: string | null = parseNextLink(res.headers.get('link'));
      let pages = 1;
      const seen = new Set([initial.href]);
      while (nextUrl && pages < maxPages) {
        let next: URL;
        try { next = trustedGithubUrl(nextUrl, initial); } catch { return fail(res, 'server', '不安全的 GitHub 分页链接'); }
        if (seen.has(next.href)) return fail(res, 'server', '分页链接循环');
        seen.add(next.href);
        if (!this.hasBudget()) return fail(res, 'rate_limited', '分页未完成：预算不足或限流');
        this.budget.used += 1;
        let pageRes: Response;
        try {
          pageRes = await fetch(next.href, {
            headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'If-None-Match')),
            redirect: 'error', signal: AbortSignal.timeout(30_000),
          });
        } catch { return fail(res, 'network', '分页网络失败或重定向被拒绝'); }
        if (!pageRes.ok) return fail(pageRes, pageRes.status === 429 ? 'rate_limited' : 'server', `分页 HTTP ${pageRes.status}`);
        let pageData: unknown;
        try { pageData = await pageRes.json(); } catch { return fail(pageRes, 'server', '分页无效 JSON'); }
        const items = options.itemsKey && pageData && typeof pageData === 'object' ? (pageData as Record<string,unknown>)[options.itemsKey] : pageData;
        if (!Array.isArray(items)) return fail(pageRes, 'server', '分页响应必须包含数组');
        collected.push(...items);
        nextUrl = parseNextLink(pageRes.headers.get('link'));
        pages += 1;
      }
      if (nextUrl) return fail(res, 'server', '分页截断：达到 maxPages');
      firstPageData = (options.itemsKey ? {...firstPageData,[options.itemsKey]:collected} : collected) as T;
    }

    const data = firstPageData;
    const etag = res.headers.get('etag');
    this.db.exec('BEGIN');
    try {
    this.writeCache(projectId, payloadKind, data); // 304 readback, query-scoped
    this.writeCache(projectId, kind, data); // convenience: latest snapshot for the kind
    this.saveEtag(cacheKey, projectId, kind, etag, 'fresh');
    this.db.exec('COMMIT');
    } catch (error) {this.db.exec('ROLLBACK');throw error;}
    return {
      ok: true,
      completeness: 'complete',
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
        completeness: 'partial',
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

/** Credential boundary: pagination may only change page on the original endpoint. */
function trustedGithubUrl(value: string, initial?: URL): URL {
  const url = new URL(value, 'https://api.github.com');
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash || !/^\/repos\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname)) throw new Error('不安全的 GitHub URL');
  if (initial) {
    const a = new URLSearchParams(initial.search); a.delete('page'); a.sort();
    const b = new URLSearchParams(url.search); b.delete('page'); b.sort();
    if (url.pathname !== initial.pathname || a.toString() !== b.toString() || !/^[1-9][0-9]*$/.test(url.searchParams.get('page') ?? '')) throw new Error('不安全的分页 URL');
  }
  return url;
}

/** The sole persistent worker-state → presentation contract projection. */
export function projectWorkerState(
  pulls: Record<string, import('./github-worker.js').NormalizedPull>,
  issues: Record<string, import('./github-worker.js').IssueSummary>,
  read: <T>(kind: string) => T | null,
  sync: { at: string; error: string | null } | null,
): CollabData {
  const pullRequests = Object.values(pulls).map(p => {
    const mapping = read<{headSha:string;files:string[]}>(`pr-files:${p.number}`);
    const ci = read<{sha:string;state:string}>(`pr-ci:${p.number}`);
    const checks = ci?.sha === p.headSha ? ci.state : 'unknown';
    return { ...p, changedFilesKnown:mapping?.headSha === p.headSha, assignees:p.assignees ?? [],
      changedFiles: mapping?.headSha === p.headSha ? mapping.files : [],
      checks: ['success','failure','pending'].includes(checks) ? checks : 'unknown' };
  });
  const normalizedIssues = Object.values(issues).filter(i => !i.pull_request).map(i => ({
    number:i.number, title:i.title, state:i.state, author:i.user?.login ?? 'unknown',
    assignees:(i.assignees ?? []).flatMap(a => a.login ? [a.login] : []),
    labels:(i.labels ?? []).flatMap(l => typeof l === 'string' ? [l] : l.name ? [l.name] : []),
    createdAt:i.created_at ?? '', updatedAt:i.updated_at ?? '', closedAt:i.closed_at ?? null,
    completion:i.state === 'closed' ? i.state_reason === 'completed' ? 'completed' : i.state_reason === 'not_planned' ? 'not_completed' : 'none' : 'none',
  }));
  return CollabDataSchema.parse({source:'live', demo:false, fetchedAt:sync?.at ?? null,
    error:sync?.error ?? null, pullRequests, issues:normalizedIssues, team:[], moduleIssues:{}, manualApprovals:{}});
}
