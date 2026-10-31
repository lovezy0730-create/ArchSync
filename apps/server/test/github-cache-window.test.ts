import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/index.js';
import { LocalDatabase } from '../src/db.js';
import { loadCollab } from '../src/github.js';
import type { ProjectEntry } from '../src/projects.js';

const PR_FIXTURE = {
  number: 11,
  title: 'Fixture PR',
  state: 'open',
  merged_at: null,
  closed_at: null,
  created_at: '2026-10-30T00:00:00Z',
  updated_at: '2026-10-30T01:00:00Z',
  head: { sha: 'fixture-head', ref: 'feature' },
  user: { login: 'alice' },
  assignees: [],
  draft: false,
};

function stubGithubFetch() {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.github.com')) return original(input, init);
    const data = url.includes('/pulls?')
      ? [PR_FIXTURE]
      : url.includes('/issues?')
        ? []
        : url.includes('/files?')
          ? [{ filename: 'src/change.ts' }]
          : url.includes('/check-runs?')
            ? { check_runs: [] }
            : url.endsWith('/status')
              ? { state: 'pending', statuses: [] }
              : url.includes('/commits?')
                ? []
                : { default_branch: 'main' };
    return new Response(JSON.stringify(data));
  });
}

const entry = {
  id: 'remote-widget',
  config: { project: { github: { owner: 'acme', repo: 'widget' } } },
  demoCollabPath: undefined,
} as unknown as ProjectEntry;

it('loadCollab reports a truthful non-null fetchedAt when sync-status is not stamped yet', async () => {
  // Mid-pass window: the worker writes pulls-state before it writes sync-status
  // at the end of the pass. Readers must not observe fetchedAt: null.
  const collab = await loadCollab(entry, null, {
    readCache: <T>(_projectId: string, kind: string): T | null =>
      kind === 'pulls-state' ? ({ '11': { number: 11, title: 'Fixture PR', phase: 'open', state: 'open', headSha: 'sha', headRef: 'feature', author: 'alice', draft: false, assignees: [], mergedAt: null, closedAt: null, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T01:00:00Z' } } as T) : null,
    cacheUpdatedAt: () => '2026-10-30T02:00:00.000Z',
  });
  expect(collab.fetchedAt).toBe('2026-10-30T02:00:00.000Z');
  expect(collab.pullRequests.map((pr) => pr.number)).toContain(11);
  expect(collab.source).toBe('live');
});

it('loadCollab still returns a schema-valid timestamp when no clock hint is available', async () => {
  const collab = await loadCollab(entry, null, {
    readCache: <T>(_projectId: string, kind: string): T | null =>
      kind === 'issues-state' ? ({} as T) : null,
  });
  expect(typeof collab.fetchedAt).toBe('string');
  expect(Number.isNaN(Date.parse(collab.fetchedAt))).toBe(false);
});

it('registry GitHub route serves 200 with cached PRs while sync-status is absent', async () => {  const root = await mkdtemp(join(tmpdir(), 'archsync-gh-window-'));
  delete process.env.ARCHSYNC_DATA_DIR;
  process.env.PORT = '0';
  stubGithubFetch();
  const server = await createServer({ repoRoot: root, quiet: true });
  try {
    const added = await fetch(server.url + '/api/v1/registry/add-github-remote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'acme', repo: 'widget' }),
    });
    expect(added.status).toBe(201);
    const { project } = (await added.json()) as { project: { id: string } };

    const db = new LocalDatabase(join(root, 'registry.sqlite'));
    const hasPullState = () =>
      Boolean(db.prepare("SELECT 1 FROM github_cache WHERE project_id = ? AND kind = 'pulls-state'").get(project.id));
    await vi.waitFor(() => expect(hasPullState()).toBe(true), { timeout: 15000, interval: 100 });

    // Reproduce the exact window that used to produce HTTP 500.
    db.prepare("DELETE FROM github_cache WHERE project_id = ? AND kind = 'sync-status'").run(project.id);

    const response = await fetch(`${server.url}/api/v1/registry/${project.id}/github`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { collab: { fetchedAt: string; pullRequests: { number: number }[] } };
    expect(Number.isNaN(Date.parse(body.collab.fetchedAt))).toBe(false);
    expect(body.collab.pullRequests.map((pr) => pr.number)).toContain(11);
  } finally {
    await server.close();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
