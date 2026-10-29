import { readFileSync } from 'node:fs';
import type { CollabData, DemoIssue, DemoPullRequest } from '@archsync/contracts';
import { collabFromCache } from './sync/github-client.js';
import { CollabDataSchema } from '@archsync/contracts';
import type { ProjectEntry } from './projects.js';

/**
 * Collaboration data adapter.
 *
 * Priority (honest, never silently faked):
 * 1. GITHUB_TOKEN configured → live GitHub REST for the project's real repo.
 *    Failures surface as source='unavailable' + error message (freshness=stale).
 * 2. No token + demo fixture present → source='demo' (UI shows DEMO badges).
 * 3. Neither → source='unavailable' with an explicit reason.
 *
 * Live-mode limitation (documented): PR changed-file lists are not fetched
 * per-PR in the MVP, so module↔PR association in live mode relies on the
 * config `issues` / `moduleIssues` mapping only.
 */
export async function loadCollab(
  entry: ProjectEntry,
  token: string | null,
  cacheReader?: { readCache: <T>(projectId: string, kind: string) => T | null },
): Promise<CollabData> {
  // SyncWorker 缓存优先：worker 轮询已把 issues/pulls 写入 github_cache，
  // 复用它避免同一轮询窗口内的重复匿名请求。
  if (cacheReader) {
    // 统一数据源：读取 SyncWorker 维护的规范化模型（pulls-state/issues-state），
    // 与时间线、模块映射使用同一份事实；旧键 pulls/issues-previous 已废弃
    const cachedIssues = cacheReader.readCache<CollabData['issues']>(entry.id, 'issues-state');
    const cachedPulls = cacheReader.readCache<CollabData['pullRequests']>(entry.id, 'pulls-state');
    if (Array.isArray(cachedPulls) && cachedPulls.length > 0) {
      const fromWorker = collabFromCache({
        pullRequests: cachedPulls,
        issues: Array.isArray(cachedIssues) ? cachedIssues : [],
        fetchedAt: null,
        error: null,
      });
      if (fromWorker) return fromWorker;
    }
  }
  if (token) {
    try {
      return await fetchLiveCollab(entry, token);
    } catch (err) {
      return CollabDataSchema.parse({
        source: 'unavailable',
        demo: false,
        fetchedAt: new Date().toISOString(),
        error: `GitHub 请求失败: ${(err as Error).message}`,
      });
    }
  }
  if (entry.demoCollabPath) {
    const raw = JSON.parse(readFileSync(entry.demoCollabPath, 'utf8')) as Record<string, unknown>;
    delete raw._notice;
    return CollabDataSchema.parse({
      ...raw,
      source: 'demo',
      demo: true,
      // fetchedAt anchors to the fixture file's mtime so identical fixtures
      // produce identical content hashes (no meaningless snapshot versions).
      fetchedAt: entry.demoCollabFetchedAt ?? new Date().toISOString(),
      error: null,
    });
  }
  return CollabDataSchema.parse({
    source: 'unavailable',
    demo: false,
    fetchedAt: new Date().toISOString(),
    error: '未配置 GITHUB_TOKEN 且该项目没有演示数据，协作状态不可用',
  });
}

async function gh(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ArchSync-MVP',
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`${path} → HTTP ${res.status}${body.message ? `: ${body.message}` : ''}`);
  }
  return res.json();
}

async function fetchLiveCollab(entry: ProjectEntry, token: string): Promise<CollabData> {
  const { owner, repo } = entry.config.project.github;
  const fetchedAt = new Date().toISOString();

  const issuesRaw = (await gh(
    `/repos/${owner}/${repo}/issues?state=all&per_page=100`,
    token,
  )) as Array<Record<string, unknown>>;

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

  const prsRaw = (await gh(
    `/repos/${owner}/${repo}/pulls?state=all&per_page=100`,
    token,
  )) as Array<Record<string, unknown>>;

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
    changedFiles: [], // per-PR file fetch intentionally not implemented in MVP
    checks: 'unknown' as const,
  }));

  const teamLogins = new Set<string>();
  for (const i of issues) teamLogins.add(i.author);
  for (const p of pullRequests) teamLogins.add(p.author);

  return CollabDataSchema.parse({
    source: 'live',
    demo: false,
    fetchedAt,
    error: null,
    team: [...teamLogins].map((login) => ({ login, name: login, role: 'developer' as const })),
    issues,
    pullRequests,
    moduleIssues: {},
    manualApprovals: {},
  });
}
