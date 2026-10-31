import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/index.js';

it('registers an unconfigured mixed repository and restores its indexed facts after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archsync-live-'));
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'export function hello(): number { return 1; }');
  await writeFile(join(repo, 'src', 'b.py'), 'def greet():\n    return 1\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  process.env.PORT = '0';
  let server = await createServer({ repoRoot: root, quiet: true });
  try {
    const response = await fetch(server.url + '/api/v1/registry/add-local', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: repo }),
    });
    expect(response.status).toBe(201);
    const { project } = await response.json() as { project: { id: string } };
    let data: { files: { symbols: { name: string }[] }[]; state: string } | undefined;
    for (let i = 0; i < 100; i++) {
      data = await (await fetch(server.url + `/api/v1/projects/${project.id}/code-index`)).json() as typeof data;
      if (data?.state === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(data?.state).toBe('ready');
    expect(data?.files.flatMap((file) => file.symbols.map((s) => s.name))).toEqual(expect.arrayContaining(['hello', 'greet']));
    const source = await fetch(server.url + `/api/v1/projects/${project.id}/source?path=src%2Fa.ts`);
    expect(await source.json()).toMatchObject({ path: 'src/a.ts', indexedContentMatches: true, content: expect.stringContaining('function hello') });
    expect((await fetch(server.url + `/api/v1/projects/${project.id}/source?path=..%2Fsecret`)).status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await writeFile(join(repo, 'src', 'a.ts'), 'export function updated(): number { return 2; }');
    for (let i = 0; i < 120; i++) {
      data = await (await fetch(server.url + `/api/v1/projects/${project.id}/code-index`)).json() as typeof data;
      if (data?.files.some((file) => file.symbols.some((s) => s.name === 'updated'))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(data?.files.flatMap((file) => file.symbols.map((s) => s.name))).toContain('updated');
    await server.close();
    server = await createServer({ repoRoot: root, quiet: true });
    const restored = await (await fetch(server.url + `/api/v1/projects/${project.id}/code-index`)).json() as typeof data;
    expect(restored?.files.flatMap((file) => file.symbols.map((s) => s.name))).toEqual(expect.arrayContaining(['updated', 'greet']));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);
