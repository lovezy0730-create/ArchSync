import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseProjectConfig } from '../src/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');

const minimal = (modules: string, layers = 'layers:\n  - id: web\n    label: 前端\n    order: 1\n'): string => `# test config
schemaVersion: 1
project:
  id: demo
  name: Demo
  github:
    owner: example
    repo: demo
    defaultBranch: main
  root: "."
${layers}
modules:
${modules}
`;

const mod = (id: string, extra = ''): string => `  - id: ${id}
    label: ${id}
    layer: web
    description: ""
    owners: []
    paths: ["src/${id}/**"]
    issues: []
    plannedDependsOn: []
${extra}
`;

describe('parseProjectConfig', () => {
  it('parses the valid sticky-notes-like fixture with deterministic order', () => {
    const result = parseProjectConfig(load('valid-project.yaml'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    if (!result.config) throw new Error('unreachable');
    expect(result.config.modules.length).toBe(10);
    expect(result.config.layers.map((l) => l.id)).toEqual([
      'ui',
      'services',
      'core',
      'infra',
    ]);
    // modules sorted by layer order then id
    const firstLayer = result.config.modules.filter((m) => m.layer === 'ui').map((m) => m.id);
    expect(firstLayer).toEqual([...firstLayer].sort());
    const edges = result.config.modules.flatMap((m) =>
      m.plannedDependsOn.map((d) => `${m.id}->${d}`),
    );
    expect(edges.length).toBe(15);
  });

  it('rejects duplicate module ids with a located error', () => {
    const result = parseProjectConfig(minimal(mod('notes') + mod('notes')));
    expect(result.ok).toBe(false);
    const dup = result.errors.find((e) => e.code === 'duplicate_module');
    expect(dup).toBeTruthy();
    expect(dup?.path).toContain('notes');
  });

  it('rejects dangling dependencies', () => {
    const result = parseProjectConfig(
      minimal(`  - id: aa
    label: a
    layer: web
    paths: []
    plannedDependsOn: ["ghost"]
`),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'dangling_dependency')).toBe(true);
  });

  it('rejects self dependency', () => {
    const result = parseProjectConfig(
      minimal(`  - id: aa
    label: a
    layer: web
    paths: []
    plannedDependsOn: ["aa"]
`),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'self_dependency')).toBe(true);
  });

  it('rejects unknown layer references', () => {
    const result = parseProjectConfig(
      minimal(`  - id: aa
    label: a
    layer: ghost-layer
    paths: []
`),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'unknown_layer')).toBe(true);
  });

  it('rejects path escapes, absolute paths and backslashes', () => {
    const cases: Array<[string, string]> = [
      ['../secret/**', 'path_escape'],
      ['/etc/**', 'path_absolute'],
      ['C:\\repo\\**', 'path_absolute|path_backslash'],
      ['src\\ui\\**', 'path_backslash'],
      ['', 'path_empty|too_small'],
    ];
    for (const [pathGlob, code] of cases) {
      const result = parseProjectConfig(
        minimal(`  - id: aa
    label: a
    layer: web
    paths: ['${pathGlob}']
`),
      );
      expect(result.ok, `path "${pathGlob}" should be rejected`).toBe(false);
      expect(
        result.errors.some((e) => code.split("|").includes(e.code)),
        `path "${pathGlob}" expected code ${code}, got ${JSON.stringify(result.errors)}`,
      ).toBe(true);
    }
  });

  it('rejects invalid schema versions and module ids', () => {
    const result = parseProjectConfig(
      minimal(mod('Bad_ID')),
    );
    // schema-level failure surfaces as zod error
    expect(result.ok).toBe(false);

    const v2 = parseProjectConfig(minimal(mod('aa')).replace('schemaVersion: 1', 'schemaVersion: 2'));
    expect(v2.ok).toBe(false);
    expect(v2.errors.length).toBeGreaterThan(0);
  });

  it('reports syntax errors with a line number when YAML is broken', () => {
    const result = parseProjectConfig('schemaVersion: 1\nproject: [\n  broken');
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('yaml_syntax');
    expect(result.errors[0]?.line).toBeGreaterThan(0);
  });

  it('warns on cycles without rejecting, and dedupes repeated edges', () => {
    const cyclic = minimal(
      `  - id: aa
    label: a
    layer: web
    paths: []
    plannedDependsOn: ["bb"]
  - id: bb
    label: b
    layer: web
    paths: []
    plannedDependsOn: ["aa"]
`,
    );
    const result = parseProjectConfig(cyclic);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'dependency_cycle')).toBe(true);

    const dupEdge = parseProjectConfig(
      minimal(`  - id: aa
    label: a
    layer: web
    paths: []
    plannedDependsOn: ["bb", "bb"]
  - id: bb
    label: b
    layer: web
    paths: []
`),
    );
    expect(dupEdge.ok).toBe(true);
    expect(dupEdge.config?.modules.find((m) => m.id === 'aa')?.plannedDependsOn).toEqual(['bb']);
    expect(dupEdge.warnings.some((w) => w.code === 'duplicate_edge')).toBe(true);
  });

  it('rejects oversized configs', () => {
    const huge = `schemaVersion: 1\nproject:\n  id: demo\n  name: Demo\n  github: {owner: o, repo: r}\nlayers:\n  - id: web\n    label: web\n    order: 1\nmodules:\n  - id: a\n    label: a\n    layer: web\n    paths: []\n    description: "${'x'.repeat(1024 * 1024 + 10)}"\n`;
    const result = parseProjectConfig(huge);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('config_too_large');
  });
});
