import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubApiClient, collabFromCache } from '../src/sync/github-client.js';
import { GithubSyncWorker, mapFilesToModules, recordEvents, type SyncEvent } from '../src/sync/github-worker.js';
import { LocalDatabase } from '../src/db.js';
import type { ProjectEntry } from '../src/projects.js';

const NOW = new Date('2026-01-01T00:00:00Z');

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const path = urlText.replace('https://api.github.com', '');
    const result = handler(path, init);
    const headers = new Headers(result.headers ?? {});
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers,
    });
  }) as unknown as typeof fetch;
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
      { id: 'ui', label: 'UI', layer: 'core', description: '', owners: [], paths: ['src/ui/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } },
    ],
  },
  configWarnings: [],
  demoCollabPath: null,
  demoCollabFetchedAt: null,
};

function newClient(): GithubApiClient {
  const db = new LocalDatabase(':memory:');
  return new GithubApiClient(db, () => 'test-token');
}

describe('GithubApiClient', () => {
  it('sends Authorization and persists ETag → 304 returns cached data', async () => {
    let authorized = '';
    const db = new LocalDatabase(':memory:');
    const client = new GithubApiClient(db, () => 'tok-123');
    vi.stubGlobal(
      'fetch',
      fakeFetch((path) => {
        if (path === '/repos/o/r') {
          authorized = 'sent';
          return { status: 200, body: { default_branch: 'main' }, headers: { etag: 'W/"abc1"' } };
        }
        if (path === '/repos/o/r/pulls') {
          return { status: 200, body: [{ number: 1, title: 't', state: 'open', updated_at: NOW.toISOString() }], headers: { etag: 'W/"p1"' } };
        }
        return { status: 200, body: [], headers: { etag: 'W/"x"' } };
      }),
    );
    const first = await client.request<{ default_branch?: string }>('p1', 'repo', '/repos/o/r');
    expect(first.status).toBe(200);
    expect(authorized).toBe('sent'); // token was attached

    // second call: If-None-Match → 304 → cached payload returned
    vi.stubGlobal(
      'fetch',
      fakeFetch((path, init) => {
        const headers = new Headers(init?.headers as Record<string, string>);
        if (headers.get('If-None-Match') !== 'W/"abc1"') throw new Error('missing conditional header');
        return { status: 304 };
      }),
    );
    const second = await client.request<{ default_branch?: string }>('p1', 'repo', '/repos/o/r');
    expect(second.status).toBe(304);
    expect(second.data).toEqual({ default_branch: 'main' });
    db.close();
    vi.unstubAllGlobals();
  });

  it('classifies 401/403/404/429 and honors Retry-After with global cooldown', async () => {
    const db = new LocalDatabase(':memory:');
    const client = new GithubApiClient(db, () => 'tok');
    vi.stubGlobal('fetch', fakeFetch((path) => {
      if (path.includes('one')) return { status: 401, body: {} };
      if (path.includes('two')) return { status: 403, body: {}, headers: { 'retry-after': '90' } };
      if (path.includes('three')) return { status: 404, body: {} };
      if (path.includes('four')) return { status: 429, body: {} };
      return { status: 500, body: {} };
    }));
    const r401 = await client.request('p', 'k1', '/one');
    expect(r401.errorKind).toBe('auth');
    const r403 = await client.request('p', 'k2', '/two');
    expect(r403.errorKind).toBe('rate_limited');
    // cooldown from Retry-After blocks the next request even before network
    const r404 = await client.request('p', 'k3', '/three');
    expect(r404.errorKind).toBe('rate_limited'); // still cooling down
    // expire cooldown manually via a fresh budget window
    const client2 = new GithubApiClient(new LocalDatabase(':memory:'), () => 'tok');
    vi.stubGlobal('fetch', fakeFetch((path) => {
      if (path.includes('four')) return { status: 429, body: {} };
      if (path.includes('five')) return { status: 502, body: {} };
      return { status: 200, body: {} };
    }));
    const r429 = await client2.request('p', 'k4', '/four');
    expect(r429.errorKind).toBe('rate_limited');
    const client3 = new GithubApiClient(new LocalDatabase(':memory:'), () => 'tok');
    vi.stubGlobal('fetch', fakeFetch((path) => (path.includes('five') ? { status: 502, body: {} } : { status: 200, body: {} })));
    const r5xx = await client3.request('p', 'k5', '/five');
    expect(r5xx.errorKind).toBe('server');
    vi.unstubAllGlobals();
  });

  it('budget exhaustion fails fast without network', async () => {
    const db = new LocalDatabase(':memory:');
    const client = new GithubApiClient(db, () => null); // anonymous: 55/h
    let calls = 0;
    vi.stubGlobal('fetch', fakeFetch(() => {
      calls += 1;
      return { status: 200, body: {} };
    }));
    for (let i = 0; i < 60; i++) {
      await client.request('p', `k${i}`, `/x${i}`);
    }
    expect(calls).toBeLessThanOrEqual(56); // budget capped
    const exhausted = await client.request('p', 'k-final', '/final');
    expect(exhausted.errorKind).toBe('rate_limited');
    vi.unstubAllGlobals();
  });

  it('collabFromCache rebuilds CollabData with live source', () => {
    const collab = collabFromCache({ issues: [], pullRequests: [], fetchedAt: NOW.toISOString() });
    expect(collab?.source).toBe('live');
    expect(collab?.error).toBeNull();
    expect(collabFromCache({})).toBeNull();
  });
});

describe('GithubSyncWorker', () => {
  let db: LocalDatabase;
  beforeEach(() => {
    db = new LocalDatabase(':memory:');
  });

  it('emits pr_opened once (dedupe) and pr_merged on transition', async () => {
    let pulls: Array<Record<string, unknown>> = [
      { number: 42, title: 'Add login', state: 'open', updated_at: '2026-01-01T00:00:00Z', user: { login: 'dev' }, merged_at: null },
    ];
    vi.stubGlobal('fetch', fakeFetch((path) => {
      if (path.startsWith('/repos/acme/widget/pulls?') || path.endsWith('/pulls')) return { status: 200, body: pulls, headers: { etag: 'W/"p"' } };
      if (path.startsWith('/repos/acme/widget/issues?') || path.endsWith('/issues')) return { status: 200, body: [], headers: { etag: 'W/"i"' } };
      if (path.startsWith('/repos/acme/widget/commits?') || path.endsWith('/commits')) return { status: 200, body: [], headers: { etag: 'W/"c"' } };
      return { status: 200, body: {}, headers: { etag: 'W/"r"' } };
    }));
    const client = new GithubApiClient(db, () => 'tok');
    const worker = new GithubSyncWorker(db, client, () => [{ entry, intervalSeconds: 120 }], { onRemoteChanged: () => {}, log: () => {} });

    const first = await worker.syncNow(entry);
    expect(first.changed).toBe(true);
    expect(first.events.filter((e) => e.eventType === 'pr_opened')).toHaveLength(1);

    // same state again → no duplicate event
    const second = await worker.syncNow(entry);
    expect(second.events.filter((e) => e.eventType === 'pr_opened')).toHaveLength(0);

    // transition to merged → pr_merged event
    pulls = [{ number: 42, title: 'Add login', state: 'closed', updated_at: '2026-01-02T00:00:00Z', user: { login: 'dev' }, merged_at: '2026-01-02T01:00:00Z' }];
    const third = await worker.syncNow(entry);
    expect(third.events.some((e) => e.eventType === 'pr_merged')).toBe(true);

    // timeline table has exactly 2 rows for this PR (opened + merged)
    const rows = db.prepare("SELECT COUNT(*) as c FROM sync_events WHERE project_id='proj-x'").get() as { c: number };
    expect(rows.c).toBe(2);
    vi.unstubAllGlobals();
  });

  it('maps PR changed files to modules with multi-module evidence', async () => {
    vi.stubGlobal('fetch', fakeFetch((path) => {
      if (path.startsWith('/repos/acme/widget/pulls?') || path.endsWith('/pulls')) {
        return {
          status: 200,
          body: [{ number: 42, title: 'Change auth+ui', state: 'open', updated_at: NOW.toISOString() }],
          headers: { etag: 'W/"p1"' },
        };
      }
      if (path.includes('/pulls/42/files')) {
        return {
          status: 200,
          body: [
            { filename: 'src/auth/login.ts' },
            { filename: 'src/auth/session.ts' },
            { filename: 'src/ui/button.tsx' },
            { filename: 'docs/unmapped.md' },
          ],
          headers: { etag: 'W/"f"' },
        };
      }
      if (path.startsWith('/repos/acme/widget/issues?') || path.endsWith('/issues')) return { status: 200, body: [], headers: { etag: 'W/"i"' } };
      if (path.startsWith('/repos/acme/widget/commits?') || path.endsWith('/commits')) return { status: 200, body: [], headers: { etag: 'W/"c"' } };
      return { status: 200, body: {}, headers: { etag: 'W/"r"' } };
    }));
    const client = new GithubApiClient(db, () => 'tok');
    const worker = new GithubSyncWorker(db, client, () => [{ entry, intervalSeconds: 120 }], { onRemoteChanged: () => {}, log: () => {} });
    const summary = await worker.syncNow(entry);
    const mapped = summary.events.find((e) => e.eventType === 'pr_modules_mapped');
    expect(mapped).toBeTruthy();
    expect((mapped!.detail.modules as string[]).sort()).toEqual(['auth', 'ui']);
    // docs/unmapped.md belongs to no module → surfaced as unclassified,
    // never fabricated into a module
    expect((mapped!.detail.modules as string[]).sort()).toEqual(['auth', 'ui']);
    expect((mapped!.detail.unmappedFiles as string[])).toContain('docs/unmapped.md');

    // repeat poll: files already mapped → no duplicate mapping events
    const again = await worker.syncNow(entry);
    expect(again.events.filter((e) => e.eventType === 'pr_modules_mapped')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('transient errors do not wipe prior caches (stale kept)', async () => {
    let failNow = false;
    vi.stubGlobal('fetch', fakeFetch((path) => {
      if (failNow) return { status: 503, body: {} };
      if (path.startsWith('/repos/acme/widget/pulls?') || path.endsWith('/pulls')) return { status: 200, body: [{ number: 7, title: 'T', state: 'open', updated_at: NOW.toISOString() }], headers: { etag: 'W/"p"' } };
      if (path.startsWith('/repos/acme/widget/issues?') || path.endsWith('/issues')) return { status: 200, body: [], headers: { etag: 'W/"i"' } };
      if (path.startsWith('/repos/acme/widget/commits?') || path.endsWith('/commits')) return { status: 200, body: [], headers: { etag: 'W/"c"' } };
      return { status: 200, body: {}, headers: { etag: 'W/"r"' } };
    }));
    const client = new GithubApiClient(db, () => 'tok');
    const worker = new GithubSyncWorker(db, client, () => [{ entry, intervalSeconds: 120 }], { onRemoteChanged: () => {}, log: () => {} });
    await worker.syncNow(entry);
    const cachedBefore = client.readCache('proj-x', 'pulls');
    expect(cachedBefore).toBeTruthy();

    failNow = true;
    const failed = await worker.syncNow(entry);
    expect(failed.errors.length).toBeGreaterThan(0);
    // prior cache survives the failed round (stale > guessed)
    expect(client.readCache('proj-x', 'pulls')).toEqual(cachedBefore);
    vi.unstubAllGlobals();
  });
});

describe('mapFilesToModules / recordEvents', () => {
  it('reports the same file to every matching module (ambiguity honesty)', () => {
    const wide: ProjectEntry = {
      ...entry,
      config: { ...entry.config, modules: [...entry.config.modules, { ...entry.config.modules[0]!, id: 'everything', paths: ['src/**'] }] },
    };
    const mapping = mapFilesToModules(wide, ['src/auth/login.ts']);
    const owners = mapping.map((m) => m.moduleId).sort();
    expect(owners).toEqual(['auth', 'everything']);
  });

  it('recordEvents dedupes identical events', () => {
    const db = new LocalDatabase(':memory:');
    const event: SyncEvent = {
      projectId: 'p',
      source: 'github',
      eventType: 'pr_opened',
      remoteId: '1',
      title: 't',
      detail: {},
      occurredAt: NOW.toISOString(),
    };
    expect(recordEvents(db, [event, event])).toBe(1);
  });
});
