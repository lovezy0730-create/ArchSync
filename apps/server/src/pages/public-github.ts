import type { CollabData, DemoIssue, DemoPullRequest } from '@archsync/contracts';
import { CollabDataSchema } from '@archsync/contracts';

/** Lightweight commit record used for "recent activity" surfaces. */
export interface RecentCommit {
  sha: string;
  headline: string;
  author: string;
  committedAt: string;
}

export interface GithubBudget {
  maxRequests: number;
  spent: number;
  remaining: number;
  rateLimited: boolean;
}

export interface PublicCollabResult {
  collab: CollabData;
  commits: RecentCommit[];
  budget: GithubBudget;
}

/**
 * Anonymous (token-free) GitHub public API fetch for published static data.
 *
 * Hard rules:
 * - No token is accepted, ever. Publishing live collaboration data is only
 *   legitimate for PUBLIC repos; a token here would signal private data
 *   about to leak into a public bundle.
 * - The project config must explicitly set publishPublicGithubData: true
 *   (checked by the caller) — this is the "public data allow list".
 * - Anonymous rate limit is 60 req/h per IP. The budget below stops fetching
 *   detail data before hitting the wall and degrades to `stale` honestly.
 *
 * Request plan (budgeted):
 *   1  issues list (state=all, 100/page — first page only)
 *   1  pulls list  (state=all, 100/page — first page only)
 *   1  commits list (30)
 *   per detailed PR (open first, then recently merged, capped):
 *   1  PR files   → module association evidence
 *   1  combined status of the PR head → checks conclusion
 */
export async function fetchPublicCollab(
  owner: string,
  repo: string,
  options: { maxRequests?: number; maxPrDetail?: number; log?: (...a: unknown[]) => void } = {},
): Promise<PublicCollabResult> {
  const log = options.log ?? (() => {});
  const maxRequests = options.maxRequests ?? 40;
  const maxPrDetail = options.maxPrDetail ?? 12;
  const budget: GithubBudget = {
    maxRequests,
    spent: 0,
    remaining: maxRequests,
    rateLimited: false,
  };

  const gh = async (path: string): Promise<unknown> => {
    if (budget.remaining <= 0) {
      throw new RateBudgetError(`请求预算耗尽（${maxRequests}），跳过剩余详情拉取`);
    }
    budget.spent += 1;
    budget.remaining -= 1;
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ArchSync-Static-Publisher',
      },
    });
    if (res.status === 403 || res.status === 429) {
      budget.rateLimited = true;
      throw new RateBudgetError(`GitHub API 限流 (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(`${path} → HTTP ${res.status}${body.message ? `: ${body.message}` : ''}`);
    }
    return res.json();
  };

  const fetchedAt = new Date().toISOString();
  try {
    const issuesRaw = (await gh(`/repos/${owner}/${repo}/issues?state=all&per_page=100`)) as Array<
      Record<string, unknown>
    >;
    const issues: DemoIssue[] = issuesRaw
      .filter((i) => !('pull_request' in i))
      .map((i) => ({
        number: i.number as number,
        title: i.title as string,
        state: i.state as 'open' | 'closed',
        assignees: ((i.assignees ?? []) as Array<{ login: string }>).map((a) => a.login),
        labels: ((i.labels ?? []) as Array<string | { name: string }>).map((l) =>
          typeof l === 'string' ? l : l.name,
        ),
        author: ((i.user ?? {}) as { login?: string }).login ?? 'unknown',
        createdAt: i.created_at as string,
        updatedAt: i.updated_at as string,
        closedAt: (i.closed_at as string | null) ?? null,
        completion:
          i.state === 'closed' && i.state_reason === 'completed'
            ? ('completed' as const)
            : i.state === 'closed'
              ? ('not_completed' as const)
              : ('none' as const),
      }));
    log(`issues: ${issues.length}`);

    const prsRaw = (await gh(`/repos/${owner}/${repo}/pulls?state=all&per_page=100`)) as Array<
      Record<string, unknown>
    >;
    const pullRequests: DemoPullRequest[] = prsRaw.map((p) => ({
      number: p.number as number,
      title: p.title as string,
      state: p.state as 'open' | 'closed',
      draft: Boolean(p.draft),
      author: ((p.user ?? {}) as { login?: string }).login ?? 'unknown',
      assignees: ((p.assignees ?? []) as Array<{ login: string }>).map((a) => a.login),
      headRef: ((p.head ?? {}) as { ref?: string }).ref ?? '',
      mergedAt: (p.merged_at as string | null) ?? null,
      closedAt: (p.closed_at as string | null) ?? null,
      createdAt: p.created_at as string,
      updatedAt: p.updated_at as string,
      changedFiles: [],
      checks: 'unknown' as const,
    }));
    log(`pulls: ${pullRequests.length}`);

    /* ---- budgeted per-PR detail: files + checks ---- */
    // open PRs first (review state matters most), then recently merged
    const detailOrder = [
      ...pullRequests.filter((p) => p.state === 'open'),
      ...pullRequests
        .filter((p) => p.mergedAt !== null)
        .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? '')),
    ].slice(0, maxPrDetail);

    for (const pr of detailOrder) {
      try {
        const filesRaw = (await gh(`/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=100`)) as Array<
          { filename?: string; previous_filename?: string }
        >;
        const files = filesRaw.map((f) => f.filename ?? '');
        pr.changedFiles = files;
        const renames = filesRaw
          .filter((f) => f.previous_filename !== undefined)
          .map((f) => f.previous_filename as string);
        if (renames.length > 0) pr.changedFiles = [...files, ...renames];
      } catch (err) {
        if (err instanceof RateBudgetError) break;
        log(`PR ${pr.number} files 拉取失败: ${(err as Error).message}`);
      }
      const headSha = ((prsRaw.find((p) => p.number === pr.number)?.head ?? {}) as { sha?: string }).sha;
      if (headSha) {
        try {
          const status = (await gh(`/repos/${owner}/${repo}/commits/${headSha}/status`)) as {
            state?: string;
          };
          const state = status.state ?? 'unknown';
          pr.checks =
            state === 'success'
              ? 'success'
              : state === 'failure' || state === 'error'
                ? 'failure'
                : state === 'pending'
                  ? 'pending'
                  : 'unknown';
        } catch (err) {
          if (err instanceof RateBudgetError) break;
          log(`PR ${pr.number} status 拉取失败: ${(err as Error).message}`);
        }
      }
    }

    /* ---- recent commits ---- */
    const commits: RecentCommit[] = [];
    try {
      const commitsRaw = (await gh(`/repos/${owner}/${repo}/commits?per_page=30`)) as Array<{
        sha?: string;
        commit?: { message?: string; author?: { name?: string; date?: string } };
      }>;
      for (const c of commitsRaw) {
        commits.push({
          sha: c.sha ?? '',
          headline: (c.commit?.message ?? '').split('\n')[0] ?? '',
          author: c.commit?.author?.name ?? 'unknown',
          committedAt: c.commit?.author?.date ?? '',
        });
      }
    } catch (err) {
      if (!(err instanceof RateBudgetError)) log(`commits 拉取失败: ${(err as Error).message}`);
    }

    const teamLogins = new Set<string>();
    for (const i of issues) teamLogins.add(i.author);
    for (const p of pullRequests) teamLogins.add(p.author);

    return {
      collab: CollabDataSchema.parse({
        source: 'live',
        demo: false,
        fetchedAt,
        error: budget.rateLimited ? `部分详情因 GitHub 匿名限流未拉取（已保留基础数据）` : null,
        team: [...teamLogins].map((login) => ({ login, name: login, role: 'developer' as const })),
        issues,
        pullRequests,
        moduleIssues: {},
        manualApprovals: {},
      }),
      commits,
      budget,
    };
  } catch (err) {
    const rateLimited = err instanceof RateBudgetError || budget.rateLimited;
    return {
      collab: CollabDataSchema.parse({
        source: rateLimited ? 'live' : 'unavailable',
        demo: false,
        fetchedAt,
        error: rateLimited
          ? `GitHub 匿名 API 限流，本轮仅取得部分数据（freshness=stale，下轮重试）`
          : `公开 GitHub 数据获取失败（仓库可能为私有）: ${(err as Error).message}`,
        team: [],
        issues: [],
        pullRequests: [],
        moduleIssues: {},
        manualApprovals: {},
      }),
      commits: [],
      budget,
    };
  }
}

class RateBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateBudgetError';
  }
}
