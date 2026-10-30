import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubApiClient, collabFromCache, parseNextLink } from '../src/sync/github-client.js';
import {
  GithubSyncWorker,
  mapFilesToModules,
  recordEvents,
  type SyncEvent,
} from '../src/sync/github-worker.js';
import { LocalDatabase } from '../src/db.js';
import type { ProjectEntry } from '../src/projects.js';

const NOW = '2026-01-01T00:00:00Z';

/**
 * GitHub 语义模拟核心约束：`pulls?state=open` 绝不返回 closed/merged PR；
 * `state=all` 返回全部。旧实现的回归测试依赖此模拟才有效。
 */
interface FakePull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  updated_at: string;
  head: { sha: string; ref: string };
  user: { login: string };
  draft: boolean;
  files?: Array<{ filename: string; previous_filename?: string }>;
}

const entry: ProjectEntry = {
  id: 'proj-x',
  name: 'Project X',
  rootDir: '/tmp/x',
  configText: '',
  configBlobSha: '0'.repeat(64),
  config: {
    schemaVersion: 1,
    project: { id: 'proj-x', name: 'X', github: { owner: 'acme', repo: 'widget', defaultBranch: 'main' }, root: '.' },
    layers: [{ id: 'core', label: 'Core', order: 1 }],
    modules: [
      { id: 'auth', label: 'Auth', layer: 'core', description: '', owners: [], paths: ['src/auth/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } },
      { id: 'payment', label: 'Payment', layer: 'core', description: '', owners: [], paths: ['src/payment/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } },
      { id: 'ui', label: 'UI', layer: 'core', description: '', owners: [], paths: ['src/ui/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } },
    ],
  },
  configWarnings: [],
  views: [],
  defaultViewId: '',
  viewDiagnostics: [],
  demoCollabPath: null,
  demoCollabFetchedAt: null,
};

function makeWorkerDb(): LocalDatabase {
  return new LocalDatabase(':memory:');
}

/** Harness with mutable GitHub state respecting real API semantics. */
class FakeGithub {
  pulls: FakePull[] = [];
  commitSha = 'base0sha';
  ciState = 'pending';
  pagesSeen: string[] = [];
  private db: LocalDatabase;
  private client: GithubApiClient;
  private fetchSpy: ReturnType<typeof vi.fn>;

  constructor(db: LocalDatabase) {
    this.db = db;
    this.client = new GithubApiClient(db, () => 'tok');
    this.fetchSpy = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace('https://api.github.com', '');
      this.pagesSeen.push(path);
      if (path.startsWith('/repos/acme/widget/pulls?')) {
        if (path.includes('state=open')) {
          // GitHub 语义：open 列表只含 open PR
          return this.json(this.pulls.filter((p) => p.state === 'open'), 'W/"pulls-open"');
        }
        return this.json(this.pulls, 'W/"pulls-all"');
      }
      if (path.startsWith('/repos/acme/widget/issues?')) return this.json([], 'W/"i"');
      if (path.startsWith('/repos/acme/widget/commits?')) {
        return this.json([{ sha: this.commitSha, commit: { message: 'head', author: { name: 'd', date: NOW } } }], 'W/"c"');
      }
      if (path.includes('/status')) return this.json({ state: this.ciState }, 'W/"st"');
      if (path.includes('/check-runs')) return this.json({ check_runs: [] }, 'W/"cr"');
      const filesMatch = path.match(/pulls\/(\d+)\/files/);
      if (filesMatch) {
        const pr = this.pulls.find((p) => p.number === Number(filesMatch[1]));
        return this.json(pr?.files ?? [], 'W/"f"');
      }
      return this.json({ default_branch: 'main', pushed_at: NOW, updated_at: NOW }, 'W/"r"');
    });
    vi.stubGlobal('fetch', this.fetchSpy);
  }

  private json(body: unknown, etag: string): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { etag, 'content-type': 'application/json' },
    });
  }

  events(worker: GithubSyncWorker): Promise<SyncEvent[]> {
    return worker.syncNow(entry).then((r) => r.events);
  }
}

function newWorker(db: LocalDatabase, github: FakeGithub): GithubSyncWorker {
  // FakeGithub constructs its own client bound to the same db (shared cache)
  const client = (github as unknown as { client: GithubApiClient }).client;
  return new GithubSyncWorker(db, client, () => [{ entry, intervalSeconds: 120 }], {
    onRemoteChanged: () => undefined,
    log: () => undefined,
  });
}

interface FakePull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  updated_at: string;
  head: { sha: string; ref: string };
  user: { login: string };
  draft: boolean;
  files?: Array<{ filename: string; previous_filename?: string }>;
}

function pull(n: number, over: Partial<FakePull> = {}): FakePull {
  return {
    number: n,
    title: `PR #${n}`,
    state: 'open',
    merged_at: null,
    updated_at: NOW,
    head: { sha: `head-${n}-a`, ref: `pr-${n}` },
    user: { login: 'dev' },
    draft: false,
    ...over,
  };
}

describe('PR state machine (GitHub-semantics mock)', () => {
  let db: LocalDatabase;
  let github: FakeGithub;

  beforeEach(() => {
    vi.unstubAllGlobals();
    db = makeWorkerDb();
    github = new FakeGithub(db);
  });

  it('1-2. first sighting seeds baseline without events; next tick is silent', async () => {
    github.pulls = [pull(1)];
    const worker = newWorker(db, github);
    const first = await github.events(worker);
    expect(first.filter((e) => e.eventType === 'pr_opened')).toHaveLength(0); // baseline

    const second = await github.events(worker);
    expect(second).toHaveLength(0);
  });

  it('3-4. open PR merged (leaves open list) → exactly one pr_merged, no repeats', async () => {
    github.pulls = [pull(1)];
    const worker = newWorker(db, github);
    await github.events(worker); // baseline

    github.pulls = [pull(1, { state: 'closed', merged_at: '2026-01-02T00:00:00Z', head: { sha: 'head-1-a', ref: 'pr-1' } })];
    const merged = await github.events(worker);
    expect(merged.filter((e) => e.eventType === 'pr_merged')).toHaveLength(1);
    expect(merged.some((e) => e.eventType === 'pr_closed')).toBe(false);

    // 再轮询五次：不重复
    for (let i = 0; i < 5; i++) {
      const again = await github.events(worker);
      expect(again.filter((e) => e.eventType === 'pr_merged')).toHaveLength(0);
    }
  });

  it('5-6. closed without merge → pr_closed (never pr_merged)', async () => {
    github.pulls = [pull(2)];
    const worker = newWorker(db, github);
    await github.events(worker);

    github.pulls = [pull(2, { state: 'closed', merged_at: null })];
    const closed = await github.events(worker);
    expect(closed.filter((e) => e.eventType === 'pr_closed')).toHaveLength(1);
    expect(closed.some((e) => e.eventType === 'pr_merged')).toBe(false);
  });

  it('7. closed PR reopened → pr_reopened', async () => {
    github.pulls = [pull(3, { state: 'closed', merged_at: null })];
    const worker = newWorker(db, github);
    await github.events(worker); // baseline with closed PR

    github.pulls = [pull(3, { state: 'open', merged_at: null })];
    const reopened = await github.events(worker);
    expect(reopened.filter((e) => e.eventType === 'pr_reopened')).toHaveLength(1);
  });

  it('8. service restart (fresh worker, same db) does not repeat old events', async () => {
    github.pulls = [pull(4)];
    const worker = newWorker(db, github);
    await github.events(worker);
    github.pulls = [pull(4, { state: 'closed', merged_at: '2026-01-03T00:00:00Z' })];
    await github.events(worker); // merged recorded

    // 模拟重启：全新 worker 实例，共享同一持久缓存
    const restarted = newWorker(db, github);
    const after = await github.events(restarted);
    expect(after.filter((e) => e.eventType === 'pr_merged')).toHaveLength(0);
  });

  it('new open PR after baseline → pr_opened with real author', async () => {
    github.pulls = [];
    const worker = newWorker(db, github);
    await github.events(worker); // baseline (empty)

    github.pulls = [pull(9, { user: { login: 'real-dev' } })];
    const opened = await github.events(worker);
    const evt = opened.find((e) => e.eventType === 'pr_opened');
    expect(evt).toBeTruthy();
    expect((evt!.detail as { author: string }).author).toBe('real-dev');
  });

  it('head push → pr_head_changed + files remapped (module added and removed)', async () => {
    github.pulls = [
      pull(42, { head: { sha: 'head-42-A', ref: 'pr-42' }, files: [{ filename: 'src/auth/login.ts' }] }),
    ];
    const worker = newWorker(db, github);
    const first = await github.events(worker);
    console.log('DBG-FIRST:', JSON.stringify(first.map((e) => ({ t: e.eventType, d: e.detail }))));
    const firstMap = first.find((e) => e.eventType === 'pr_modules_mapped');
    expect((firstMap!.detail as { modules: string[] }).modules).toEqual(['auth']);

    // HEAD B：新增 payment 文件 → Auth + Payment
    github.pulls = [pull(42, { head: { sha: 'head-42-B', ref: 'pr-42' }, files: [
      { filename: 'src/auth/login.ts' },
      { filename: 'src/payment/order.ts' },
    ] })];
    const second = await github.events(worker);
    expect(second.some((e) => e.eventType === 'pr_head_changed')).toBe(true);
    const remap = second.find((e) => e.eventType === 'pr_modules_mapped');
    expect((remap!.detail as { modules: string[] }).modules.sort()).toEqual(['auth', 'payment']);

    // HEAD C：移除 auth 变更 → 仅 Payment（失效映射必须被删除）
    github.pulls = [pull(42, { head: { sha: 'head-42-C', ref: 'pr-42' }, files: [
      { filename: 'src/payment/order.ts' },
    ] })];
    const third = await github.events(worker);
    const remap3 = third.find((e) => e.eventType === 'pr_modules_mapped');
    expect((remap3!.detail as { modules: string[] }).modules).toEqual(['payment']);
  });

  it('renamed files count via previous_filename', async () => {
    github.pulls = [pull(5, { head: { sha: 'head-5', ref: 'pr-5' }, files: [
      { filename: 'src/ui/new.tsx', previous_filename: 'src/ui/old.tsx' },
    ] })];
    const worker = newWorker(db, github);
    const events = await github.events(worker);
    const mapped = events.find((e) => e.eventType === 'pr_modules_mapped');
    expect((mapped!.detail as { modules: string[] }).modules).toEqual(['ui']);
  });

  it('CI pending → failure transitions are reported (check-runs + combined status)', async () => {
    github.commitSha = 'ci-head';
    github.ciState = 'pending';
    const worker = newWorker(db, github);
    const first = await github.events(worker);
    expect(first.some((e) => e.eventType === 'ci_status' && (e.detail as { state: string }).state === 'pending')).toBe(true);

    github.ciState = 'failure';
    const second = await github.events(worker);
    const fail = second.find((e) => e.eventType === 'ci_status');
    expect((fail!.detail as { state: string }).state).toBe('failure');

    // 终态后不再重复
    const third = await github.events(worker);
    expect(third.filter((e) => e.eventType === 'ci_status')).toHaveLength(0);
  });

  it('pagination: >30 PRs across pages are all tracked', async () => {
    // FakeGithub 的 pulls 端点一次返回全部；这里通过 Link header 验证分页合并
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes('/pulls?') && url.includes('page=2')) {
        return new Response(JSON.stringify([pull(32)]), { status: 200, headers: { etag: 'W/"p2"' } });
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify([pull(31)]), {
          status: 200,
          headers: { etag: 'W/"p1"', link: `<${url.split('?')[0]}?state=all&page=2&per_page=30>; rel="next"` },
        });
      }
      if (url.includes('/issues?')) return new Response('[]', { status: 200, headers: { etag: 'W/"i"' } });
      if (url.includes('/commits?')) return new Response('[]', { status: 200, headers: { etag: 'W/"c"' } });
      return new Response('{}', { status: 200, headers: { etag: 'W/"r"' } });
    }));
    const client = new GithubApiClient(db, () => 'tok');
    const result = await client.request<unknown[]>('proj-x', 'pulls-paginate', '/repos/acme/widget/pulls?state=all&per_page=30', { paginate: true });
    expect((result.data as unknown[]).length).toBe(2); // page1 + page2 merged
    vi.unstubAllGlobals();
  });

  it('304 without cached payload falls back to unconditional refetch', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const hasConditional = Boolean((init?.headers as Record<string, string> | undefined)?.['If-None-Match']);
      if (hasConditional) {
        // GitHub 语义：仅当客户端发送条件头时才可能 304
        return new Response(null, { status: 304, headers: { etag: 'W/"x"' } });
      }
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { etag: 'W/"x"' } });
    }));
    const client = new GithubApiClient(db, () => 'tok');
    const first = await client.request<{ default_branch?: string }>('p', 'repo', '/repos/o/r');
    console.log('DBG-304-FIRST:', JSON.stringify({ status: first.status, err: first.error, kind: first.errorKind, budget: client.budgetStatus() }));
    expect(first.status).toBe(200);
    // 清掉 payload 缓存（保留 etag 行）→ 304 时必须触发无条件重取，
    // 不得把无 payload 的 304 当作可用数据
    db.prepare('DELETE FROM github_cache WHERE project_id = ?').run('p');
    console.log('DBG-CACHE-AFTER-DELETE:', JSON.stringify(
      db.prepare('SELECT project_id, kind FROM github_cache').all()));
    console.log('DBG-ETAG:', JSON.stringify(db.prepare('SELECT * FROM github_etags').all()));
    const second = await client.request<{ default_branch?: string }>('p', 'repo', '/repos/o/r');
    expect(second.status).toBe(200);
    expect(second.data).toEqual({ default_branch: 'main' });
    // 正确行为：payload 缺失时客户端根本不发条件头（无谓的 304 风险为零），
    // 因此流程是 200 → 无条件 200，两次调用、无 304 误判。
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });
});

describe('mapFilesToModules / recordEvents / helpers', () => {
  it('ambiguous files attach to every matching module', () => {
    const wide: ProjectEntry = {
      ...entry,
      config: { ...entry.config, modules: [...entry.config.modules, { ...entry.config.modules[0]!, id: 'everything', paths: ['src/**'] }] },
    };
    const mapping = mapFilesToModules(wide, ['src/auth/login.ts']);
    expect(mapping.map((m) => m.moduleId).sort()).toEqual(['auth', 'everything']);
  });

  it('recordEvents dedupes identical events', () => {
    const db = new LocalDatabase(':memory:');
    const event: SyncEvent = { projectId: 'p', source: 'github', eventType: 'pr_opened', remoteId: '1', title: 't', detail: {}, occurredAt: NOW };
    expect(recordEvents(db, [event, event])).toBe(1);
  });

  it('parseNextLink extracts rel=next', () => {
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x>; rel="last"'))
      .toBe('https://api.github.com/x?page=2');
    expect(parseNextLink(null)).toBeNull();
  });

  it('collabFromCache normalizes raw shapes without field bleed', () => {
    const raw = { issues: [{ number: 3, title: 'i', state: 'open' }], pullRequests: [{ number: 1, title: 'p', state: 'open' }], fetchedAt: NOW };
    const collab = collabFromCache(raw as unknown as Parameters<typeof collabFromCache>[0]);
    expect(collab?.pullRequests[0]?.changedFiles).toEqual([]);
    expect(collab?.issues[0]?.labels).toEqual([]);
    expect(collabFromCache({})).toBeNull();
  });
});


describe('worker SQLite → collaboration → snapshot projection', () => {
  it('projects persisted records and PR files after reopening SQLite', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadCollab } = await import('../src/github.js');
    const { buildSnapshot } = await import('@archsync/graph');
    const dir = mkdtempSync(join(tmpdir(), 'rc4-contract-'));
    let db = new LocalDatabase(join(dir, 'state.sqlite'));
    try {
      const fake = new FakeGithub(db);
      fake.pulls = [{ number: 42, title: 'Login', state: 'open', merged_at: null, updated_at: NOW,
        head: { sha: 'head42', ref: 'feature' }, user: { login: 'alice' }, draft: false,
        files: [{ filename: 'src/auth/login.ts' }] }];
      const worker = newWorker(db, fake);
      await worker.syncNow(entry);
      db.close(); db = new LocalDatabase(join(dir, 'state.sqlite'));
      const collab = await loadCollab(entry, null, new GithubApiClient(db, () => null));
      expect(collab.source).toBe('live');
      expect(collab.pullRequests[0]).toMatchObject({ number:42, author:'alice', headRef:'feature', changedFiles:['src/auth/login.ts'] });
      const snap = buildSnapshot({ config:entry.config, configWarnings:[], configBlobSha:'config',
        scan:{ ok:true, baselineSha:'head', branch:'main', baselineFiles:[], workspaceFiles:[], overlay:[], scannedAt:NOW, modules:[], errors:[], importAnalysisRan:false, observedDependencies:[] },
        collab, version:1, snapshotId:'snap', now:NOW });
      expect(JSON.stringify(snap.modules.find(m => m.id === 'auth'))).toContain('42');
    } finally { db.close(); vi.unstubAllGlobals(); rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
  });
});
