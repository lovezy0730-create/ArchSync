import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectEntry } from '../src/projects.js';

const dirs: string[] = [];

const projectYaml = `
schemaVersion: 1
project:
  id: views-test
  name: Views Test
  github: { owner: example, repo: views-test, defaultBranch: main }
  root: "."
layers:
  - { id: ui, label: UI, order: 1 }
modules:
  - id: ui
    label: UI
    layer: ui
    paths: ["src/ui/**"]
  - id: api
    label: API
    layer: ui
    paths: ["src/api/**"]
  - id: store
    label: Store
    layer: ui
    paths: ["src/store/**"]
`;

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('project view diagnostics', () => {
  it('keeps a project loadable and reports structured errors for ghost module references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archsync-views-diag-'));
    dirs.push(root);
    const configDir = join(root, '.archsync');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'project.yaml'), projectYaml, 'utf8');
    await writeFile(join(configDir, 'views.yaml'), `
schemaVersion: 1
defaultView: systems
views:
  - id: systems
    label: 系统
    groups:
      - id: all
        label: 全部
        order: 1
        moduleIds: [ui, api, store, ghost-module]
`, 'utf8');

    const entry = loadProjectEntry(join(configDir, 'project.yaml'));
    expect('error' in entry).toBe(false);
    if ('error' in entry) throw new Error(entry.error);

    expect(entry.views).toEqual([]);
    expect(entry.defaultViewId).toBe('');
    const error = entry.viewDiagnostics.find((diagnostic) => diagnostic.severity === 'error');
    expect(error?.file).toBe('.archsync/views.yaml');
    expect(error?.code).toBe('unknown_view_module');
    expect(error?.path).toContain('moduleIds');
    expect(error?.message).toContain('ghost-module');
  });
});