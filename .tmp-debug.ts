import { GithubApiClient } from './apps/server/src/sync/github-client.js';
import { GithubSyncWorker } from './apps/server/src/sync/github-worker.js';
import { LocalDatabase } from './apps/server/src/db.js';
import type { ProjectEntry } from './apps/server/src/projects.js';
import { vi } from 'vitest';

const entry: ProjectEntry = {
  id: 'proj-x', name: 'X', rootDir: '/tmp/x', configText: '', configBlobSha: '0'.repeat(64),
  config: {
    schemaVersion: 1,
    project: { id: 'proj-x', name: 'X', github: { owner: 'acme', repo: 'widget', defaultBranch: 'main' }, root: '.' },
    layers: [{ id: 'core', label: 'C', order: 1 }],
    modules: [{ id: 'auth', label: 'Auth', layer: 'core', description: '', owners: [], paths: ['src/auth/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } }],
  },
  configWarnings: [], demoCollabPath: null, demoCollabFetchedAt: null,
};

const db = new LocalDatabase(':memory:');
const client = new GithubApiClient(db, () => 'tok');
let pulls: Array<Record<string, unknown>> = [];
vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = url.replace('https://api.github.com', '');
  if (path.startsWith('/repos/acme/widget/pulls?')) return new Response(JSON.stringify(pulls), { status: 200, headers: { etag: 'W/"p"' } });
  if (path.includes('/status')) return new Response(JSON.stringify({ state: 'pending' }), { status: 200, headers: { etag: 'W/"s"' } });
  if (path.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: [] }), { status: 200, headers: { etag: 'W/"cr"' } });
  if (path.includes('/files')) return new Response(JSON.stringify(pulls[0]?.files ?? []), { status: 200, headers: { etag: 'W/"f"' } });
  if (path.includes('/issues')) return new Response('[]', { status: 200, headers: { etag: 'W/"i"' } });
  if (path.includes('/commits?')) return new Response(JSON.stringify([{ sha: 'head-1-a', commit: { message: 'm', author: { name: 'd', date: '2026' } } }]), { status: 200, headers: { etag: 'W/"c"' } });
  return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { etag: 'W/"r"' } });
}));

const worker = new GithubSyncWorker(db, client, () => [{ entry, intervalSeconds: 120 }], { onRemoteChanged: () => {}, log: (...a: unknown[]) => console.log('[log]', ...a) });
pulls = [{ number: 1, title: 't', state: 'open', merged_at: null, updated_at: '2026', head: { sha: 'head-1-a' }, user: { login: 'dev' }, draft: false, files: [{ filename: 'src/auth/login.ts' }] }];
const first = await worker.syncNow(entry);
console.log('FIRST:', JSON.stringify({ types: first.events.map(e => e.eventType), changed: first.changed, errors: first.errors }));
pulls = [{ number: 1, title: 't2', state: 'open', merged_at: null, updated_at: '2027', head: { sha: 'head-1-b' }, user: { login: 'dev' }, draft: false, files: [{ filename: 'src/auth/other.ts' }] }];
const second = await worker.syncNow(entry);
console.log('SECOND:', JSON.stringify({ types: second.events.map(e => e.eventType), errors: second.errors }));
process.exit(0);
