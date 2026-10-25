import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeModuleScans,
  isIgnoredPath,
  listWorkspaceFiles,
  matchPaths,
  parseGitStatusPorcelain,
  toPosix,
} from '../src/index.js';
import type { ProjectConfigFile, ScanOverlayChange } from '@archsync/contracts';

const cfg = (paths: string[]): ProjectConfigFile => ({
  schemaVersion: 1,
  project: {
    id: 'demo',
    name: 'demo',
    github: { owner: 'o', repo: 'r', defaultBranch: 'main' },
    root: '.',
  },
  layers: [{ id: 'ui', label: 'UI', order: 1 }],
  modules: [
    {
      id: 'mod-a',
      label: 'A',
      layer: 'ui',
      description: '',
      owners: [],
      paths,
      issues: [],
      plannedDependsOn: [],
      acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false },
    },
  ],
});

describe('matchPaths', () => {
  it('matches nested globs and stays POSIX', () => {
    const files = ['src/ui/notes/a.ts', 'src/ui/notes/sub/b.ts', 'src/ui/other/c.ts', 'README.md'];
    expect(matchPaths(['src/ui/notes/**'], files)).toEqual([
      'src/ui/notes/a.ts',
      'src/ui/notes/sub/b.ts',
    ]);
    expect(matchPaths(['src/**/*.ts'], files)).toEqual([
      'src/ui/notes/a.ts',
      'src/ui/notes/sub/b.ts',
      'src/ui/other/c.ts',
    ]);
    expect(matchPaths([], files)).toEqual([]);
  });

  it('never returns ignored or sensitive files', () => {
    const files = ['src/.env', 'src/.env.local', 'src/keep.ts', 'a/node_modules/x.js', 'dist/b.js'];
    expect(matchPaths(['src/**'], files)).toEqual(['src/keep.ts']);
    expect(matchPaths(['**/*'], files)).toEqual(['src/keep.ts']);
  });
});

describe('isIgnoredPath / toPosix', () => {
  it('normalizes windows separators and flags ignored dirs', () => {
    expect(toPosix('apps\\web\\src\\a.ts')).toBe('apps/web/src/a.ts');
    expect(isIgnoredPath('node_modules/x.js')).toBe(true);
    expect(isIgnoredPath('.git/config')).toBe(true);
    expect(isIgnoredPath('.env.production')).toBe(true);
    expect(isIgnoredPath('src/main.ts')).toBe(false);
  });
});

describe('computeModuleScans', () => {
  it('separates baseline, workspace and overlay, detects overlap', () => {
    const config = cfg(['src/a/**']);
    const config2: ProjectConfigFile = {
      ...config,
      modules: [
        ...config.modules,
        { ...config.modules[0]!, id: 'mod-b', label: 'B', paths: ['src/a/shared.ts'] },
      ],
    };
    const overlay: ScanOverlayChange[] = [
      { path: 'src/a/old.ts', kind: 'deleted', untracked: false },
      { path: 'src/a/new.ts', kind: 'added', untracked: true },
      { path: 'src/elsewhere/x.ts', kind: 'modified', untracked: false },
    ];
    const result = computeModuleScans(
      config2,
      ['src/a/old.ts', 'src/a/shared.ts'],
      ['src/a/old.ts', 'src/a/shared.ts', 'src/a/new.ts'],
      overlay,
    );
    const a = result.find((m) => m.moduleId === 'mod-a')!;
    expect(a.matchedBaselinePaths).toEqual(['src/a/old.ts', 'src/a/shared.ts']);
    expect(a.matchedWorkspacePaths).toContain('src/a/new.ts');
    expect(a.overlayChanges).toEqual([
      { path: 'src/a/old.ts', kind: 'deleted', untracked: false },
      { path: 'src/a/new.ts', kind: 'added', untracked: true },
    ]);
    expect(a.overlappedWith).toEqual(['mod-b']);
  });
});

describe('parseGitStatusPorcelain', () => {
  it('parses untracked, modified, deleted and renames from -z output', () => {
    const z = ['?? src/new.ts\0', ' M src/mod.ts\0', 'D  src/gone.ts\0', 'R  src/renamed.ts\0src/orig.ts\0']
      .join('');
    const changes = parseGitStatusPorcelain(z);
    expect(changes).toEqual([
      { path: 'src/new.ts', kind: 'added', untracked: true },
      { path: 'src/mod.ts', kind: 'modified', untracked: false },
      { path: 'src/gone.ts', kind: 'deleted', untracked: false },
      { path: 'src/orig.ts', kind: 'deleted', untracked: false },
      { path: 'src/renamed.ts', kind: 'added', untracked: false },
    ]);
  });

  it('drops sensitive paths from the overlay', () => {
    expect(parseGitStatusPorcelain('?? .env\0?? src/ok.ts\0')).toEqual([
      { path: 'src/ok.ts', kind: 'added', untracked: true },
    ]);
  });
});

describe('listWorkspaceFiles', () => {
  it('walks the tree, ignores noise, does not follow ignored dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archsync-scan-'));
    try {
      await mkdir(join(dir, 'src', 'ui'), { recursive: true });
      await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, 'src', 'ui', 'a.ts'), 'export {};\n');
      await writeFile(join(dir, 'src', '.env'), 'SECRET=1\n');
      await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), '');
      await writeFile(join(dir, '.git', 'HEAD'), 'ref');
      await writeFile(join(dir, 'README.md'), '# x\n');
      const files = await listWorkspaceFiles(dir);
      expect(files).toEqual(['README.md', 'src/ui/a.ts']);
      // sanity: readdir sees the noise, the walker must filter it
      expect((await readdir(join(dir))).length).toBeGreaterThan(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
