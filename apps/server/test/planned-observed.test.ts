import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/index.js';

it('keeps unplanned source files separate from YAML-planned modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archsync-plan-'));
  await mkdir(join(root, '.archsync'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'extra'));
  await writeFile(join(root, '.archsync', 'project.yaml'), `schemaVersion: 1\nproject:\n  id: sample\n  name: Sample\n  github: { owner: local, repo: sample, defaultBranch: main }\n  root: "."\nlayers:\n  - { id: core, label: Core, order: 1 }\nmodules:\n  - { id: planned, label: Planned, layer: core, paths: ["src/**"] }\n`);
  await writeFile(join(root, 'src', 'a.ts'), 'export function planned() {}');
  await writeFile(join(root, 'extra', 'b.ts'), 'export function discovered() {}');
  process.env.PORT = '0';
  const server = await createServer({ repoRoot: root, quiet: true });
  try {
    const index = await (await fetch(`${server.url}/api/v1/projects/sample/code-index`)).json() as { modules: { id: string }[]; files: { filePath: string; moduleId: string }[] };
    expect(index.files.find((file) => file.filePath === 'src/a.ts')?.moduleId).toBe('planned');
    expect(index.files.find((file) => file.filePath === 'extra/b.ts')?.moduleId).toBe('__observed_unplanned__');
    expect(index.modules.some((module) => module.id === '__observed_unplanned__')).toBe(true);
  } finally { await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 30000);
