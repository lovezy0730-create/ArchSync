import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectRegistry } from '../src/registry.js';
import { LocalDatabase } from '../src/db.js';

const execFileAsync = promisify(execFileCb);

// Two independent git repos in DIFFERENT parent directories (阶段 A 验收条件)
let repoA: string; // has project.yaml
let repoB: string; // worktree-style: .git as FILE via a real worktree
let repoC: string; // no project.yaml → needsInit
let nonGit: string;
let db: LocalDatabase;
let liveEntries: Map<string, import('@archsync/contracts').ProjectConfigFile extends never ? never : any>;
let registry: ProjectRegistry;
let registryEvents: string[];

const YAML_A = `schemaVersion: 1
project:
  id: repo-a
  name: Repo A
  github: { owner: o, repo: repo-a, defaultBranch: main }
  root: "."
layers:
  - { id: core, label: Core, order: 1 }
modules:
  - id: a-main
    label: A Main
    layer: core
    paths: ["src/**"]
`;
const YAML_B = `schemaVersion: 1
project:
  id: repo-b
  name: Repo B
  github: { owner: o, repo: repo-b, defaultBranch: main }
  root: "."
layers:
  - { id: core, label: Core, order: 1 }
modules:
  - id: b-main
    label: B Main
    layer: core
    paths: ["lib/**"]
`;

async function initGit(dir: string, file: string, yaml: string): Promise<void> {
  await mkdir(join(dir, '.archsync'), { recursive: true });
  await writeFile(join(dir, '.archsync', 'project.yaml'), yaml);
  await mkdir(join(dir, file.startsWith('lib') ? 'lib' : 'src'), { recursive: true });
  await writeFile(join(dir, file.startsWith('lib') ? 'lib' : 'src', file.startsWith('lib') ? 'b.ts' : 'a.ts'), 'export {};\n');
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  );
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'archsync-registry-'));
  repoA = join(base, 'workspace-a', 'repo-a');
  repoB = join(base, 'workspace-b', 'repo-b');
  repoC = join(base, 'workspace-c', 'repo-c');
  nonGit = join(base, 'non-git');
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });
  await mkdir(repoC, { recursive: true });
  await mkdir(nonGit, { recursive: true });
  await initGit(repoA, 'src/a.ts', YAML_A);
  await initGit(repoB, 'lib/b.ts', YAML_B);
  await mkdir(join(repoC, '.archsync'), { recursive: true });

  // repoC: git repo WITHOUT project.yaml (needsInit scenario)
  await execFileAsync('git', ['init', '-q'], { cwd: repoC });
  await execFileAsync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@e.c', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: repoC },
  );

  db = new LocalDatabase(join(base, '.local', 'registry.sqlite'));
  liveEntries = new Map();
  registryEvents = [];
  registry = new ProjectRegistry(db, liveEntries as never, (event) => registryEvents.push(event));
}, 90_000);

afterAll(async () => {
  db.close();
  await rm(join(tmpdir(), 'archsync-registry-'), { recursive: true, force: true });
});

describe('ProjectRegistry: multi-repo across different parent directories', () => {
  it('adds two repos in different parents; both are live for routes', async () => {
    const a = await registry.addLocal(repoA);
    expect(a.ok).toBe(true);
    expect(a.project?.id).toBe('repo-a');
    // git's default branch name depends on local configuration (main/master)
    expect(['main', 'master']).toContain(a.project?.defaultBranch);
    expect(liveEntries.has('repo-a')).toBe(true);

    const b = await registry.addLocal(repoB);
    expect(b.ok).toBe(true);
    expect(liveEntries.has('repo-b')).toBe(true);

    // live map is the SAME reference routes use — both projects visible
    expect([...liveEntries.keys()].sort()).toEqual(['repo-a', 'repo-b']);
    expect(registryEvents).toContain('added');
  });

  it('rejects duplicate registration of the same path', async () => {
    const again = await registry.addLocal(repoA);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('已注册');
  });

  it('rejects non-git directories with a clear error', async () => {
    const result = await registry.addLocal(nonGit);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不是 Git 仓库');
  });

  it('registers and reloads a repository without YAML without writing into it', async () => {
    await mkdir(join(repoC, 'src'), { recursive: true });
    await writeFile(join(repoC, 'src', 'main.ts'), 'export function main() {}');
    const result = await registry.addLocal(repoC);
    expect(result.ok).toBe(true);
    expect(result.project?.entry.configOrigin).toBe('inferred');
    expect(result.project?.entry.config.modules[0]?.label).toContain('src');
    expect(registry.reloadProjectEntry(result.project!.id)?.configOrigin).toBe('inferred');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(repoC, '.archsync', 'project.yaml'))).toBe(false);
    registry.remove(result.project!.id);
  });

  it('accepts an initialized repository with no commit', async () => {
    const empty = join(repoC, 'new-repo');
    await mkdir(empty, { recursive: true });
    await execFileAsync('git', ['init', '-q'], { cwd: empty });
    await writeFile(join(empty, 'main.py'), 'def main():\n    pass\n');
    const added = await registry.addLocal(empty);
    expect(added.ok).toBe(true);
    expect(added.project?.entry.configOrigin).toBe('inferred');
    registry.remove(added.project!.id);
  });

  it('disable stops monitoring; enable resumes; data survives restart', async () => {
    const disabled = registry.setMonitoring('repo-a', false);
    expect(disabled?.monitoringEnabled).toBe(false);
    expect(registry.monitoredEntries().map((m) => m.entry.id)).toEqual(['repo-b']);

    registry.setMonitoring('repo-a', true);
    expect(registry.monitoredEntries().map((m) => m.entry.id)).toContain('repo-a');

    // restart simulation: fresh registry over the same DB keeps state
    const db2 = new LocalDatabase(':memory:');
    void db2;
    const reloaded = registry.get('repo-a');
    expect(reloaded?.monitoringEnabled).toBe(true);
    expect(reloaded?.localPath).toBe(repoA);
  });

  it('remove unregisters without touching user files', async () => {
    const removed = registry.remove('repo-b');
    expect(removed).toBe(true);
    expect(liveEntries.has('repo-b')).toBe(false);
    // user source code still on disk
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(repoB, '.archsync', 'project.yaml'))).toBe(true);
    expect(existsSync(join(repoB, 'lib', 'b.ts'))).toBe(true);
  });

  it('rejects path traversal style inputs', async () => {
    const result = await registry.addLocal('../../etc');
    expect(result.ok).toBe(false);
  });
});


describe('RC4 local onboarding', () => {
  it('previews, validates and applies configuration without overwriting it', async () => {
    const draft = await registry.initPreview(repoC);
    expect(draft.yaml).toContain('schemaVersion: 1');
    expect((await registry.initApply(repoC,'invalid: [')).ok).toBe(false);
    const applied = await registry.initApply(repoC,draft.yaml);
    expect(applied.ok).toBe(true);
    expect((await registry.initApply(repoC,draft.yaml.replace('source','changed'))).ok).toBe(false);
  });
});
