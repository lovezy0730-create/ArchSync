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
let tmpRepo: string;
const ACCESS_CODE = 'deploy-test-code-2026';

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
  process.env.PORT = '0';
  tmpRepo = await mkdtemp(join(tmpdir(), 'archsync-auth-'));
  await mkdir(join(tmpRepo, '.archsync'), { recursive: true });
  await mkdir(join(tmpRepo, 'src', 'a'), { recursive: true });
  await writeFile(join(tmpRepo, '.archsync', 'project.yaml'), PROJECT_YAML);
  await writeFile(join(tmpRepo, 'src', 'a', 'main.ts'), 'export {};\n');
  await execFileAsync('git', ['init', '-q'], { cwd: tmpRepo });
  await execFileAsync('git', ['add', '-A'], { cwd: tmpRepo });
  await execFileAsync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'],
    { cwd: tmpRepo },
  );
  handle = await createServer({
    repoRoot: tmpRepo,
    databasePath: join(tmpRepo, '.local', 'state.json'),
    quiet: true,
    authMode: 'code',
    authCode: ACCESS_CODE,
  });
}, 60_000);

afterAll(async () => {
  await handle.close();
  await rm(tmpRepo, { recursive: true, force: true });
});

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const pair = setCookie.split(';')[0] ?? '';
  return pair.length > 0 ? pair : '';
}

describe('access-code auth mode', () => {
  it('reports mode and unauthenticated state via /me', async () => {
    const res = await fetch(`${handle.url}/api/v1/me`);
    const me = (await res.json()) as { mode: string; authenticated: boolean };
    expect(me.mode).toBe('code');
    expect(me.authenticated).toBe(false);
  });

  it('rejects a wrong code with 401 and no cookie', async () => {
    const res = await fetch(`${handle.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'wrong-code-123' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('issues an HttpOnly session cookie for the correct code', async () => {
    const res = await fetch(`${handle.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain(ACCESS_CODE); // cookie must not leak the code
  });

  it('unauthenticated READS are also 401 (unified gate)', async () => {
    // the gap this closes: GET endpoints must not leak data anonymously
    const endpoints = [
      '/api/v1/projects',
      '/api/v1/projects/testproj/snapshot',
      '/api/v1/projects/testproj/modules/mod-a',
      '/api/v1/projects/testproj/team',
      '/api/v1/jobs/whatever',
    ];
    for (const ep of endpoints) {
      const res = await fetch(`${handle.url}${ep}`);
      expect(res.status, `GET ${ep} should require a session`).toBe(401);
    }
    const validate = await fetch(`${handle.url}/api/v1/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: 'schemaVersion: 1' }),
    });
    expect(validate.status).toBe(401);
    // healthz stays public for probes
    expect((await fetch(`${handle.url}/healthz`)).status).toBe(200);
  });

  it('authenticated reads succeed with a valid session cookie', async () => {
    const login = await fetch(`${handle.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    const cookie = (res => res.headers.get('set-cookie')?.split(';')[0] ?? '')(login);
    const projects = await fetch(`${handle.url}/api/v1/projects`, { headers: { cookie } });
    expect(projects.status).toBe(200);
  });

  it('unauthenticated mutation is 401; cookie grants access', async () => {
    const url = `${handle.url}/api/v1/projects/testproj/modules/mod-a/annotation`;
    const body = JSON.stringify({ text: '通过访问码写入', expectedRevision: 1 });

    const denied = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-archsync-user': 'visitor' },
      body,
    });
    expect(denied.status).toBe(401);

    const login = await fetch(`${handle.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    const cookie = cookieFrom(login);
    expect(cookie).toContain('archsync_session=');

    const ok = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-archsync-user': 'visitor', cookie },
      body,
    });
    expect(ok.status).toBe(200);
  });

  it('me reflects authenticated state with the cookie', async () => {
    const login = await fetch(`${handle.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    const cookie = cookieFrom(login);
    const me = (await (
      await fetch(`${handle.url}/api/v1/me`, { headers: { cookie } })
    ).json()) as { authenticated: boolean };
    expect(me.authenticated).toBe(true);
  });

  it('websocket accepts a valid cookie session and rejects without one', async () => {
    const port = new URL(handle.url).port;

    const login = await fetch(`${handle.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    const cookie = cookieFrom(login);

    const ok = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?projectId=testproj&user=${encodeURIComponent('访客')}`, {
        headers: { cookie },
      });
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('error', (err) => reject(err));
    });
    expect(ok).toBe(101);

    // @fastify/websocket completes the HTTP upgrade before the handler runs,
    // so a denied connection opens briefly and then receives close 4003.
    const deniedCode = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?projectId=testproj&user=x`);
      ws.once('close', (code) => resolve(code));
      ws.once('error', () => resolve(-2));
      setTimeout(() => resolve(-3), 5000);
    });
    expect(deniedCode).toBe(4003);
  }, 30_000);

  it('logout revokes the session', async () => {
    const login = await fetch(`${handle.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    const cookie = cookieFrom(login);
    await fetch(`${handle.url}/api/v1/auth/logout`, { method: 'POST', headers: { cookie } });
    const me = (await (
      await fetch(`${handle.url}/api/v1/me`, { headers: { cookie } })
    ).json()) as { authenticated: boolean };
    expect(me.authenticated).toBe(false);
  });
});
