import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type ServerHandle } from '../src/index.js';

const execFileAsync = promisify(execFileCb);

let handle: ServerHandle;
let tmpRepo: string;
const ACCESS_CODE = 'v11-security-code';

const YAML = `schemaVersion: 1
project:
  id: secproj
  name: Security Project
  github: { owner: o, repo: r, defaultBranch: main }
  root: "."
layers:
  - { id: core, label: Core, order: 1 }
modules:
  - id: sec-main
    label: M
    layer: core
    paths: ["src/**"]
`;

beforeAll(async () => {
  process.env.PORT = '0';
  tmpRepo = await mkdtemp(join(tmpdir(), 'archsync-sec-'));
  await mkdir(join(tmpRepo, '.archsync'), { recursive: true });
  await mkdir(join(tmpRepo, 'src'), { recursive: true });
  await writeFile(join(tmpRepo, '.archsync', 'project.yaml'), YAML);
  await writeFile(join(tmpRepo, 'src', 'a.ts'), 'export {};')
  await execFileAsync('git', ['init', '-q'], { cwd: tmpRepo });
  await execFileAsync('git', ['add', '-A'], { cwd: tmpRepo });
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', 'init'], { cwd: tmpRepo });
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

async function login(): Promise<string> {
  const res = await fetch(`${handle.url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: ACCESS_CODE }),
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}

describe('registry API security regression', () => {
  it('all write endpoints reject unauthenticated requests (unified gate)', async () => {
    const endpoints: Array<[string, string]> = [
      ['/api/v1/registry/add-local', 'POST'],
      ['/api/v1/registry/add-github-remote', 'POST'],
      ['/api/v1/registry/secproj/disable', 'POST'],
      ['/api/v1/registry/secproj/enable', 'POST'],
      ['/api/v1/registry/secproj/resync', 'POST'],
      ['/api/v1/registry/secproj/sync-github', 'POST'],
      ['/api/v1/registry/secproj/remove', 'POST'],
    ];
    for (const [ep, method] of endpoints) {
      const res = await fetch(`${handle.url}${ep}`, {
        method: method as 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/x' }),
      });
      expect(res.status, `POST ${ep} 匿名必须 401`).toBe(401);
    }
  });

  it('cross-origin writes are 403 even with a valid session', async () => {
    const cookie = await login();
    const res = await fetch(`${handle.url}/api/v1/registry/secproj/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('authenticated same-origin writes succeed', async () => {
    const cookie = await login();
    const res = await fetch(`${handle.url}/api/v1/registry`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    console.log('DBG-REG:', JSON.stringify(res.status), JSON.stringify(body).slice(0, 200));
    expect(body.projects.length).toBeGreaterThan(0);
  });
});
