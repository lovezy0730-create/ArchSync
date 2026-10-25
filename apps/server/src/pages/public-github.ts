import type { CollabData, DemoIssue, DemoPullRequest } from '@archsync/contracts';
import { CollabDataSchema } from '@archsync/contracts';

/**
 * Anonymous (token-free) GitHub public API fetch for published static data.
 *
 * Hard rules:
 * - No token is accepted, ever. Publishing live collaboration data is only
 *   legitimate for PUBLIC repos; a token here would signal private data
 *   about to leak into a public bundle.
 * - The project config must explicitly set publishPublicGithubData: true
 *   (checked by the caller) — this is the "public data allow list".
 * - Anonymous rate limit is 60 req/h per IP; the two list calls below stay
 *   far inside it. CI schedules must respect that (see docs/pages-deploy.md).
 */
export async function fetchPublicCollab(owner: string, repo: string): Promise<CollabData> {
  const fetchedAt = new Date().toISOString();
  try {
    const issuesRaw = (await ghJson(`/repos/${owner}/${repo}/issues?state=all&per_page=100`)) as Array<
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

    const prsRaw = (await ghJson(`/repos/${owner}/${repo}/pulls?state=all&per_page=100`)) as Array<
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

    return CollabDataSchema.parse({
      source: 'live',
      demo: false,
      fetchedAt,
      error: null,
      team: [],
      issues,
      pullRequests,
      moduleIssues: {},
      manualApprovals: {},
    });
  } catch (err) {
    return CollabDataSchema.parse({
      source: 'unavailable',
      demo: false,
      fetchedAt,
      error: `公开 GitHub 数据获取失败（仓库可能为私有或限流）: ${(err as Error).message}`,
    });
  }
}

async function ghJson(path: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ArchSync-Static-Publisher',
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`${path} → HTTP ${res.status}${body.message ? `: ${body.message}` : ''}`);
  }
  return res.json();
}
