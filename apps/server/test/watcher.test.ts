import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceWatcher } from '../src/sync/watcher.js';
import type { ProjectEntry } from '../src/projects.js';

const entry: ProjectEntry = {
  id: 'wt-project',
  name: 'WT',
  rootDir: '', // filled in beforeAll
  configText: '',
  configBlobSha: '0'.repeat(64),
  config: {
    schemaVersion: 1,
    project: { id: 'wt-project', name: 'WT', github: { owner: 'o', repo: 'r', defaultBranch: 'main' }, root: '.' },
    layers: [{ id: 'core', label: 'Core', order: 1 }],
    modules: [{ id: 'm', label: 'M', layer: 'core', description: '', owners: [], paths: ['src/**'], issues: [], plannedDependsOn: [], acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false } }],
  },
  configWarnings: [],
  views: [],
  defaultViewId: '',
  viewDiagnostics: [],
  demoCollabPath: null,
  demoCollabFetchedAt: null,
};

let root = '';
let events: string[];
let watcher: WorkspaceWatcher | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archsync-watch-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'seed.ts'), 'export {};\n');
  entry.rootDir = root;
  events = [];
});

afterEach(async () => {
  await watcher?.stop();
  watcher = null;
  await rm(root, { recursive: true, force: true });
});

describe('WorkspaceWatcher', () => {
  it('fires for a project living under a noisy ancestor path (.local)', async () => {
    watcher = new WorkspaceWatcher([entry], { onProjectChanged: (e) => events.push(e.id) }, 100);
    watcher.start();
    // chokidar needs a moment to initialize the watch
    await new Promise((r) => setTimeout(r, 600));
    await writeFile(join(root, 'src', 'probe.ts'), 'export const p = 1;\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(events).toContain('wt-project');
  }, 20_000);

  it('ignores node_modules inside the project', async () => {
    watcher = new WorkspaceWatcher([entry], { onProjectChanged: (e) => events.push(e.id) }, 100);
    watcher.start();
    await new Promise((r) => setTimeout(r, 600));
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'x.js'), 'void 0;\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(events).toEqual([]);
  }, 20_000);
});
