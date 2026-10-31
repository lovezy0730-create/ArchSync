import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AST_VERSION } from '@archsync/scanner/ast';
import { CodeIndex } from './code-index.js';
import { LocalDatabase } from './db.js';
import { scanAstIndex } from './ast-index.js';
import { summarize } from './index-benchmark.js';
import { generateTsFixture, writeFixture } from './bench-fixtures.js';

// Deterministic source, not prebuilt SymbolDrafts. Shared with the watcher
// latency benchmark so both reports describe the same fixture.
const fixture = generateTsFixture();
const dataset = fixture.files;
const datasetHash = fixture.hash;
const output = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !output) throw new Error('--out required');
/** Samples per scenario; the frozen report uses the default, profiling runs shrink it. */
const iterations = Number(process.env.BENCH_ITERATIONS ?? 10);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error('BENCH_ITERATIONS must be a positive integer');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', windowsHide: true }).trim().length > 0;
type Sample = { parseMs: number; analysisMs: number; indexMs: number; totalMs: number; rssBytes: number; peakRssBytes: number; cpuMicros: NodeJS.CpuUsage; fsRead: number; fsWrite: number };
const scenarios: { name: string; samples: Sample[]; statistics?: { parse: ReturnType<typeof summarize>; index: ReturnType<typeof summarize>; total: ReturnType<typeof summarize> } }[] = [];
const report = { scope: 'observational real TS AST and SQLite; not a fixed-hardware performance gate or UI benchmark', datasetVersion: 'rc5-ts-1000-v1', seed: 0, datasetHash, files: dataset.length, parserVersion: AST_VERSION, gitSha: sha, gitDirty: dirty, environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version }, scenarios };
mkdirSync(dirname(resolve(output)), { recursive: true });
for (const scenario of ['cold', 'single-file-edit']) {
  const item: typeof scenarios[number] = { name: scenario, samples: [] };
  scenarios.push(item);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const dir = mkdtempSync(join(tmpdir(), 'archsync-rc5-large-'));
    const db = new LocalDatabase(':memory:');
    try {
      writeFixture(dir, dataset);
      const index = new CodeIndex(db);
      if (scenario !== 'cold') {
        scanAstIndex(dir, 'benchmark', index);
        writeFileSync(join(dir, dataset[0]!.path), dataset[0]!.source.replace('return n + 0', 'return n + 1'));
      }
      const cpu = process.cpuUsage(), io = process.resourceUsage();
      const result = scanAstIndex(dir, 'benchmark', index);
      const after = process.resourceUsage();
      if (result.files !== dataset.length || result.diagnostics.length) throw new Error('invalid benchmark sample');
      item.samples.push({ parseMs: result.parseMs, analysisMs: result.analysisMs, indexMs: result.commitMs, totalMs: result.totalMs, rssBytes: process.memoryUsage().rss, peakRssBytes: after.maxRSS * 1024, cpuMicros: process.cpuUsage(cpu), fsRead: after.fsRead - io.fsRead, fsWrite: after.fsWrite - io.fsWrite });
      writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(`${scenario} ${iteration + 1}/${iterations}: ${Math.round(result.totalMs)}ms`);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); }
  }
  item.statistics = { parse: summarize(item.samples.map((sample) => sample.parseMs)), index: summarize(item.samples.map((sample) => sample.indexMs)), total: summarize(item.samples.map((sample) => sample.totalMs)) };
  writeFileSync(output, JSON.stringify(report, null, 2));
}
