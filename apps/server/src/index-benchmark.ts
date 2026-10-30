import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus, totalmem, platform, release, arch } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalDatabase } from "./db.js";
import { CodeIndex, type FileUpdate } from "./code-index.js";
export function summarize(values: number[]) {
  if (values.length < 10 || values.some((v) => !Number.isFinite(v) || v < 0))
    throw new Error("need at least 10 valid samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    count: sorted.length,
  };
}
export function generateDataset(seed: number) {
  if (!Number.isInteger(seed)) throw new Error("integer seed required");
  let state = seed >>> 0;
  const files: FileUpdate[] = Array.from({ length: 10 }, (_, f) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const hash = String(state);
    const filePath = `src/file-${f}.ts`;
    return {
      projectId: "benchmark",
      moduleId: "core",
      filePath,
      language: "typescript",
      contentHash: hash,
      parserVersion: "synthetic-symbols-1",
      configVersion: "1",
      scannedAt: "2026-10-30T00:00:00Z",
      status: "fresh",
      diagnostics: [],
      relations: [],
      symbols: Array.from({ length: 10 }, (_, i) => ({
        projectId: "benchmark",
        moduleId: "core",
        filePath,
        language: "typescript",
        kind: "function",
        name: `f${i}`,
        qualifiedName: `f${i}`,
        signature: `f${i}()`,
        overload: "",
        parameters: [],
        returnType: null,
        exported: true,
        visibility: "public",
        startLine: i * 3 + 1,
        endLine: i * 3 + 2,
        parentSymbolUid: null,
        decorators: [],
        modifiers: [],
        docComment: null,
        sourceHash: hash,
        parserVersion: "synthetic-symbols-1",
        scannedAt: "2026-10-30T00:00:00Z",
        analysisStatus: "resolved",
        evidence: [],
        fingerprint: `${f}-${i}-${hash}`,
      })),
    };
  });
  return {
    version: "synthetic-index-1",
    seed,
    files,
    hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}
export async function runBenchmark(seed = 7, iterations = 10) {
  if (!Number.isInteger(iterations) || iterations < 10)
    throw new Error("at least 10 iterations");
  const dataset = generateDataset(seed);
  const scenarios = [];
  for (const name of ["cold-index", "incremental-index"]) {
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const db = new LocalDatabase(":memory:");
      try {
        const index = new CodeIndex(db);
        if (name === "incremental-index")
          index.applyBatch("benchmark", dataset.files);
        const changed = {
          ...dataset.files[0]!,
          contentHash: "changed",
          symbols: dataset.files[0]!.symbols.map((s) => ({
            ...s,
            sourceHash: "changed",
          })),
        };
        const cpu = process.cpuUsage(),
          io = process.resourceUsage(),
          start = performance.now();
        index.applyBatch(
          "benchmark",
          name === "cold-index" ? dataset.files : [changed],
        );
        const elapsedMs = performance.now() - start;
        const after = process.resourceUsage();
        samples.push({
          elapsedMs,
          cpuMicros: process.cpuUsage(cpu),
          rssBytesAfter: process.memoryUsage().rss,
          processHighWaterRssBytes: after.maxRSS * 1024,
          fsRead: after.fsRead - io.fsRead,
          fsWrite: after.fsWrite - io.fsWrite,
        });
      } finally {
        db.close();
      }
    }
    scenarios.push({
      name,
      samples,
      statistics: summarize(samples.map((s) => s.elapsedMs)),
    });
  }
  return {
    reportVersion: 1,
    scope: "synthetic index transactions; NOT AST scanning or UI performance",
    dataset: {
      version: dataset.version,
      seed: dataset.seed,
      hash: dataset.hash,
      files: 10,
      symbols: 100,
    },
    parserVersion: "synthetic-symbols-1",
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    gitDirty:
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim().length > 0,
    environment: {
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
      electron: process.versions.electron ?? null,
    },
    measurement: {
      cache:
        "new in-memory SQLite per sample; migration excluded; incremental baseline excluded",
      rss: "process lifetime high-water RSS, not scenario-isolated peak",
      io: "OS resourceUsage counters; may be zero/unsupported on Windows",
      classification: "observational; no performance compliance claim",
    },
    scenarios,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!process.argv.includes("--out") || !out)
    throw new Error("--out path required");
  const report = await runBenchmark();
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`wrote ${out}; synthetic indexing only`);
}
