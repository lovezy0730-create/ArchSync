#!/usr/bin/env node
/**
 * Performance acceptance fixture: injects a synthetic 50-module / 110-edge
 * snapshot into the static bundle so the graph can be measured in a real
 * browser. The project is clearly labelled SYNTHETIC and never touches the
 * publishStatic pipeline (it writes straight into public/data after
 * `snapshot:generate`).
 *
 *   pnpm perf:inject          # after pnpm snapshot:generate
 *   pnpm build:pages && pnpm preview:pages
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'apps', 'web', 'public', 'data');

const MODULES = 50;
const EDGES = 110;

function makeConfig() {
  const layers = [
    { id: 'web', label: '前端', order: 1 },
    { id: 'server', label: '服务', order: 2 },
    { id: 'core', label: '核心', order: 3 },
    { id: 'infra', label: '基础', order: 4 },
    { id: 'data', label: '数据', order: 5 },
  ];
  const modules = [];
  for (let i = 0; i < MODULES; i++) {
    const layer = layers[i % layers.length];
    modules.push({
      id: `mod-${String(i).padStart(2, '0')}`,
      label: `模块 ${String(i).padStart(2, '0')}`,
      layer: layer.id,
      description: `性能测试合成模块 #${i}（SYNTHETIC，非真实项目）`,
      plannedPaths: [`src/m${i}/**`],
      plannedDependsOn: [],
      dependedOnBy: [],
      matchedBaselinePaths: [`src/m${i}/index.ts`],
      matchedWorkspacePaths: [`src/m${i}/index.ts`, `src/m${i}/impl.ts`],
      overlayChanges: i % 9 === 0 ? [{ path: `src/m${i}/impl.ts`, kind: 'modified', untracked: false }] : [],
      observedDependsOn: [],
      implementation: ['verified', 'detected_unverified', 'not_detected', 'unknown'][i % 4],
      workflow: ['done', 'in_progress', 'in_review', 'blocked', 'not_started'][i % 5],
      owners: [`dev-${i % 7}`],
      assignees: i % 3 === 0 ? [`dev-${(i + 1) % 7}`] : [],
      contributors: [`dev-${i % 5}`],
      issueNumbers: i % 4 === 0 ? [100 + i] : [],
      pullRequestNumbers: i % 6 === 0 ? [200 + i] : [],
      evidence: [
        { source: 'yaml', ref: '.archsync/project.yaml', observedAt: '2026-10-25T00:00:00Z', demo: false, details: {} },
      ],
      warnings: [],
    });
  }
  // deterministic edge assignment: forward-only DAG + cross-layer hops
  let made = 0;
  for (let i = 0; i < MODULES && made < EDGES; i++) {
    for (const step of [1, 3, 7, 11]) {
      const target = i + step;
      if (target < MODULES && made < EDGES) {
        modules[i].plannedDependsOn.push(`mod-${String(target).padStart(2, '0')}`);
        modules[target].dependedOnBy.push(`mod-${String(i).padStart(2, '0')}`);
        // every other edge is import-confirmed
        if (made % 2 === 0) modules[i].observedDependsOn.push(`mod-${String(target).padStart(2, '0')}`);
        made += 1;
      }
    }
  }
  const edges = [];
  for (const m of modules) {
    for (const dep of m.plannedDependsOn) {
      const confirmed = m.observedDependsOn.includes(dep);
      edges.push({ id: `${m.id}->${dep}`, source: m.id, target: dep, kind: confirmed ? 'confirmed' : 'planned', demo: false });
    }
  }
  return { layers, modules, edges, made };
}

const { layers, modules, edges, made } = makeConfig();
const now = new Date().toISOString();
const snapshot = {
  id: `snap-perf-${randomUUID().slice(0, 6)}`,
  projectId: 'perf-stress',
  projectName: '性能压测（合成 50 模块 / 110 边）',
  version: 1,
  branch: 'synthetic',
  sourceCommitSha: '0'.repeat(40),
  configBlobSha: '0'.repeat(40),
  scope: 'local-workspace',
  generatedAt: now,
  githubFetchedAt: null,
  githubSource: 'unavailable',
  githubDemo: false,
  freshness: 'fresh',
  scanCompleteness: 'complete',
  dependencyAnalysis: 'partial',
  layers,
  modules,
  edges,
  warnings: ['SYNTHETIC 性能压测项目 —— 数据为合成，不代表任何真实仓库'],
  contentHash: 'perf000000000000',
};

await writeFile(
  join(dataDir, 'snapshot-perf-stress.json'),
  JSON.stringify(
    {
      kind: 'archsync-static-snapshot',
      snapshotVersion: 1,
      snapshot,
      moduleDetails: {},
    },
    null,
    1,
  ),
  'utf8',
);

const manifestPath = join(dataDir, 'index.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.projects = manifest.projects.filter((p) => p.id !== 'perf-stress');
manifest.projects.push({
  id: 'perf-stress',
  name: snapshot.projectName,
  file: 'snapshot-perf-stress.json',
  version: 1,
  generatedAt: now,
  contentHash: snapshot.contentHash,
  sourceCommitSha: snapshot.sourceCommitSha,
  githubSource: 'unavailable',
  historyIndex: 'data/history/perf-stress/index.json',
});
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`perf fixture injected: ${modules.length} modules, ${made} planned deps (${edges.length} edges incl. confirmed)`);
