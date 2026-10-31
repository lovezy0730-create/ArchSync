import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateTsFixture, writeFixture } from './bench-fixtures.js';
import { summarize } from './index-benchmark.js';
import { createServer } from './index.js';

/**
 * Observational watcher latency benchmark.
 *
 * Measures what a user experiences after saving a file: watcher debounce →
 * rebuild → fresh code index. The rebuild path currently rescans the whole
 * project tree; it is NOT a per-file incremental scan, and the report says so.
 *
 * Usage: BENCH_ITERATIONS=10 pnpm exec tsx apps/server/src/watch-latency-benchmark.ts --out <report.json>
 */
const output = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !output) throw new Error('--out required');
const iterations = Number(process.env.BENCH_ITERATIONS ?? 10);
if (!Number.isInteger(iterations) || iterations < 10) throw new Error('BENCH_ITERATIONS must be an integer >= 10 for valid percentiles');

const fixture = generateTsFixture();
const root = mkdtempSync(join(tmpdir(), 'archsync-watch-bench-'));
const repo = join(root, 'repo');
writeFixture(repo, fixture.files);
execFileSync('git', ['init', '-q', repo], { windowsHide: true });
execFileSync('git', ['-C', repo, 'add', '-A'], { windowsHide: true });
execFileSync('git', ['-C', repo, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'fixture'], { windowsHide: true });
const datasetHash = fixture.hash;

process.env.PORT = '0';
const server = await createServer({ repoRoot: root, quiet: process.env.ARCHSYNC_REBUILD_TIMING !== '1' });
const samples: number[] = [];
const report: Record<string, unknown> = {
  scope:
    'observational end-to-end watcher latency on the packaged server path; the watcher triggers a warm full rescan, not a per-file incremental scan. Not a fixed-hardware gate.',
  datasetVersion: fixture.version,
  datasetHash,
  files: fixture.files.length,
  iterations,
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    node: process.version,
  },
  gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  gitDirty:
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
};
try {
  const added = await fetch(server.url + '/api/v1/registry/add-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repo }),
  });
  if (added.status !== 201) throw new Error(`add-local failed: ${added.status} ${await added.text()}`);
  const { project } = (await added.json()) as { project: { id: string } };

  type Index = { state: string; files: { filePath: string; revision: number; status: string }[] };
  const readIndex = async (): Promise<Index> =>
    (await (await fetch(server.url + `/api/v1/projects/${project.id}/code-index`)).json()) as Index;

  const coldStart = performance.now();
  let index = await readIndex();
  while (index.state !== 'ready') {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    index = await readIndex();
  }
  report.coldAddToReadyMs = Math.round(performance.now() - coldStart);
  const target = 'src/pkg0/f0.ts';
  const currentRevision = () => index.files.find((file) => file.filePath === target)?.revision ?? 0;
  let revision = currentRevision();
  if (revision < 1) throw new Error('fixture file was not indexed');

  for (let i = 0; i < iterations; i++) {
    // Let the previous rebuild finish draining before measuring the next save;
    // otherwise queue time from the prior snapshot is attributed to this edit.
    await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
    // Each save changes the function body, so the content hash and the fresh
    // revision must change end to end.
    const source = fixture.files[0]!.source.replace('return n + 0', `return n + ${1000 + i}`);
    const started = performance.now();
    writeFileSync(join(repo, target), source);
    const deadline = started + 60000;
    for (;;) {
      index = await readIndex();
      const file = index.files.find((item) => item.filePath === target);
      if (file && file.revision > revision && file.status === 'fresh') {
        revision = file.revision;
        break;
      }
      if (performance.now() > deadline) throw new Error(`watcher did not refresh ${target} in time (revision ${revision})`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const elapsed = performance.now() - started;
    samples.push(elapsed);
    console.log(`watch save->fresh ${i + 1}/${iterations}: ${Math.round(elapsed)}ms`);
  }
  const watchStatistics = summarize(samples);
  report.watch = { samplesMs: samples, statistics: watchStatistics };
  writeFileSync(resolve(output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(watchStatistics));
  console.log(`cold add-local -> ready: ${report.coldAddToReadyMs}ms`);
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
