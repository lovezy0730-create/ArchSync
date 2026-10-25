import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { createServer, type ServerHandle } from '../src/index.js';

const execFileAsync = promisify(execFileCb);

let handle: ServerHandle;
let dbPath: string;
let tmpRepo: string;

const PROJECT_YAML = `schemaVersion: 1
project:
  id: testproj
  name: Test Project
  github: { owner: o, repo: r, defaultBranch: main }
  root: "."
layers:
  - { id: ui, label: UI, order: 1 }
modules:
  - id: mod-a
    label: A
    layer: ui
    paths: ["src/a/**"]
    issues: []
    plannedDependsOn: []
`;

beforeAll(async () => {
  process.env.PORT = '0'; // ephemeral port for the test server
  tmpRepo = await mkdtemp(join(tmpdir(), 'archsync-server-'));
  await mkdir(join(tmpRepo, '.archsync'), { recursive: true });
  await mkdir(join(tmpRepo, 'src', 'a'), { recursive: true });
  await writeFile(join(tmpRepo, '.archsync', 'project.yaml'), PROJECT_YAML);
  await writeFile(join(tmpRepo, 'src', 'a', 'main.ts'), 'export {};\n');
  // the scanner derives "committed baseline" from git; give the tmp repo one
  await execFileAsync('git', ['init', '-q'], { cwd: tmpRepo });
  await execFileAsync('git', ['add', '-A'], { cwd: tmpRepo });
  await execFileAsync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'],
    { cwd: tmpRepo },
  );
  dbPath = join(tmpRepo, '.local', 'state.json');
  handle = await createServer({
    repoRoot: tmpRepo,
    databasePath: dbPath,
    quiet: true,
  });
}, 60_000);

afterAll(async () => {
  await handle.close();
  await rm(tmpRepo, { recursive: true, force: true });
});

describe('REST API', () => {
  it('healthz responds ok', async () => {
    const res = await fetch(`${handle.url}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('lists the discovered project', async () => {
    const res = await fetch(`${handle.url}/api/v1/projects`);
    const body = (await res.json()) as { projects: Array<{ id: string; moduleCount: number }> };
    expect(body.projects.some((p) => p.id === 'testproj')).toBe(true);
  });

  it('serves a snapshot with module states and ETag', async () => {
    const res = await fetch(`${handle.url}/api/v1/projects/testproj/snapshot`);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      version: number;
      modules: Array<{ id: string; implementation: string }>;
    };
    expect(snap.modules[0]?.id).toBe('mod-a');
    // testproj source file exists but acceptance rules are empty → unverified
    expect(snap.modules[0]?.implementation).toBe('detected_unverified');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    const again = await fetch(`${handle.url}/api/v1/projects/testproj/snapshot`, {
      headers: { 'if-none-match': etag! },
    });
    expect(again.status).toBe(304);
  });

  it('returns 404 for unknown projects and modules', async () => {
    expect((await fetch(`${handle.url}/api/v1/projects/ghost/snapshot`)).status).toBe(404);
    expect(
      (await fetch(`${handle.url}/api/v1/projects/testproj/modules/ghost`)).status,
    ).toBe(404);
  });

  it('module detail includes annotation with initial revision', async () => {
    const res = await fetch(`${handle.url}/api/v1/projects/testproj/modules/mod-a`);
    const detail = (await res.json()) as { annotation: { revision: number; text: string } };
    expect(detail.annotation.revision).toBe(1);
    expect(detail.annotation.text).toBe('');
  });

  it('annotation optimistic lock: first write ok, stale write 409', async () => {
    const url = `${handle.url}/api/v1/projects/testproj/modules/mod-a/annotation`;
    const headers = { 'content-type': 'application/json', 'x-archsync-user': 'alice' };

    const first = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ text: '第一版备注', expectedRevision: 1 }),
    });
    expect(first.status).toBe(200);
    const { revision } = (await first.json()) as { revision: number };
    expect(revision).toBe(2);

    // concurrent writer bumped it to 3
    const second = await fetch(url, {
      method: 'PATCH',
      headers: { ...headers, 'x-archsync-user': 'bob' },
      body: JSON.stringify({ text: '并发写入', expectedRevision: 2 }),
    });
    expect(second.status).toBe(200);

    // stale writer (still on revision 2) must conflict
    const stale = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ text: '过时写入', expectedRevision: 2 }),
    });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { current: { revision: number } };
    expect(conflict.current.revision).toBe(3);
  });

  it('rejects annotation writes without identity', async () => {
    const res = await fetch(`${handle.url}/api/v1/projects/testproj/modules/mod-a/annotation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', expectedRevision: 3 }),
    });
    expect(res.status).toBe(401);
  });

  it('config validate rejects broken yaml with located errors', async () => {
    const res = await fetch(`${handle.url}/api/v1/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: 'schemaVersion: 2\n' }),
    });
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('sync enqueues a job that reaches done', async () => {
    const res = await fetch(`${handle.url}/api/v1/projects/testproj/sync`, { method: 'POST' });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    let job: { state: string } | null = null;
    for (let i = 0; i < 40; i++) {
      const jobRes = await fetch(`${handle.url}/api/v1/jobs/${jobId}`);
      job = (await jobRes.json()) as { state: string };
      if (job.state === 'done' || job.state === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job?.state).toBe('done');
  });
});

describe('presence websocket', () => {
  interface Client {
    ws: WebSocket;
    messages: Array<Record<string, unknown>>;
    waitFor: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  }

  const open = (user: string): Promise<Client> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${new URL(handle.url).port}/ws?projectId=testproj&user=${encodeURIComponent(user)}`,
      );
      const messages: Array<Record<string, unknown>> = [];
      const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
      const client: Client = {
        ws,
        messages,
        waitFor: (type: string) =>
          new Promise((res, rej) => {
            const existing = messages.find((m) => m.type === type);
            if (existing) return res(existing);
            waiters.push({ type, resolve: res });
            setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), 10_000);
          }),
      };
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        messages.push(msg);
        const idx = waiters.findIndex((w) => w.type === msg.type);
        if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(msg);
      });
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });

  it('two sessions see each other, broadcast selection and reject bad project', async () => {
    const a = await open('alice');
    const b = await open('bob');

    const helloA = await a.waitFor('hello');
    expect(helloA.type).toBe('hello');
    await a.waitFor('presence.roster');
    // b joined after a → a receives presence.changed for b
    const changed = await a.waitFor('presence.changed');
    expect((changed as { participant: { name: string } }).participant.name).toBe('bob');

    a.ws.send(
      JSON.stringify({
        type: 'presence.update',
        projectId: 'testproj',
        payload: { selectedModuleId: 'mod-a', cursor: { x: 10, y: 20 } },
      }),
    );
    const updateOnB = await b.waitFor('presence.changed');
    const participant = (updateOnB as { participant: Record<string, unknown> }).participant;
    expect(participant.selectedModuleId).toBe('mod-a');
    expect(participant.cursor).toEqual({ x: 10, y: 20 });

    a.ws.close();
    b.ws.close();

    const bad = new WebSocket(`ws://127.0.0.1:${new URL(handle.url).port}/ws?projectId=ghost&user=x`);
    const closed = await new Promise<{ code: number }>((resolve) => {
      bad.once('close', (code) => resolve({ code }));
    });
    expect(closed.code).toBe(4004);
  }, 30_000);
});
