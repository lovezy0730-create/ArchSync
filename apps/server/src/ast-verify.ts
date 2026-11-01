import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LocalDatabase } from "./db.js";
import { CodeIndex } from "./code-index.js";
import { scanAstIndex } from "./ast-index.js";
import { summarize } from "./index-benchmark.js";
import { AST_VERSION } from "@archsync/scanner/ast";
import { cpus, totalmem, release } from "node:os";
export function verifyAst(root: string) {
  const dir = mkdtempSync(join(tmpdir(), "archsync-ast-proof-"));
  const db = new LocalDatabase(join(dir, "registry.sqlite"));
  try {
    const index = new CodeIndex(db);
    const metrics = scanAstIndex(root, "archsync-proof", index);
    const files = index
      .files("archsync-proof")
      .filter((f) =>
        [
          "packages/scanner/src/",
          "apps/server/src/sync/",
          "apps/web/src/",
        ].some((p) => f.filePath.startsWith(p)),
      );
    const symbols = files.flatMap((f) => f.symbols);
    const examples = ["analyzeImports", "resolveSpecifier", "matchSymbols"].map(
      (name) => {
        const s = symbols.find((s) => s.name === name && s.kind === "function");
        if (!s) throw new Error("missing actual function " + name);
        const text = readFileSync(join(root, s.filePath), "utf8").split(
          /\r?\n/,
        );
        if (
          !text
            .slice(s.startLine - 1, s.endLine)
            .join("\n")
            .includes(s.name)
        )
          throw new Error("bad source range");
        return {
          name: s.name,
          signature: s.signature,
          filePath: s.filePath,
          startLine: s.startLine,
          endLine: s.endLine,
        };
      },
    );
    return {
      scope:
        "read-only actual sources; temporary SQLite; no YAML/network/execution",
      sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
        }).trim() !== "",
      parserVersion: AST_VERSION,
      files: files.length,
      symbols: symbols.length,
      kinds: Object.fromEntries(
        [...new Set(symbols.map((s) => s.kind))].map((k) => [
          k,
          symbols.filter((s) => s.kind === k).length,
        ]),
      ),
      imports: files
        .flatMap((f) => f.relations)
        .filter((r) => r.kind === "imports").length,
      resolved: files
        .flatMap((f) => f.relations)
        .filter((r) => r.strength === "resolved").length,
      unresolved: files
        .flatMap((f) => f.relations)
        .filter((r) => r.strength !== "resolved").length,
      diagnostics: files.flatMap((f) => f.diagnostics),
      examples,
      metrics: {
        ...metrics,
        relations: metrics.relations.length,
        diagnostics: metrics.diagnostics.length,
      },
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
}
export function benchmarkAst() {
  const dataset = Array.from(
    { length: 32 },
    (_, i) => `export function f${i}(n:number):number { return n + ${i}; }\n`,
  );
  const scenarios = [];
  for (const name of [
    "cold",
    "cached",
    "edit",
    "delete",
    "restore",
    "rename",
    "move",
  ]) {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const dir = mkdtempSync(join(tmpdir(), "rc5-ast-bench-"));
      const db = new LocalDatabase(":memory:");
      try {
        mkdirSync(join(dir, "src"));
        dataset.forEach((s, j) => writeFileSync(join(dir, `src/f${j}.ts`), s));
        const index = new CodeIndex(db);
        if (name !== "cold") scanAstIndex(dir, "benchmark", index);
        const path = join(dir, "src/f0.ts");
        if (name === "edit")
          writeFileSync(path, dataset[0]!.replace("+ 0", "+ 99"));
        if (name === "delete" || name === "restore") unlinkSync(path);
        if (name === "restore") {
          scanAstIndex(dir, "benchmark", index);
          writeFileSync(path, dataset[0]!);
        }
        if (name === "rename")
          writeFileSync(path, dataset[0]!.replace("f0", "renamed"));
        if (name === "move") renameSync(path, join(dir, "src/moved.ts"));
        const cpu = process.cpuUsage();
        const r = scanAstIndex(
          dir,
          "benchmark",
          index,
          name === "move" ? { "src/f0.ts": "src/moved.ts" } : {},
        );
        samples.push({
          parseMs: r.parseMs,
          indexMs: r.commitMs,
          totalMs: r.totalMs,
          analysisMs: r.analysisMs,
          cachedFiles: r.cachedFiles,
          cpuMicros: process.cpuUsage(cpu),
          rssBytes: process.memoryUsage().rss,
        });
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
      }
    }
    scenarios.push({
      name,
      samples,
      parse: summarize(samples.map((s) => s.parseMs)),
      index: summarize(samples.map((s) => s.indexMs)),
      total: summarize(samples.map((s) => s.totalMs)),
    });
  }
  return {
    parserVersion: AST_VERSION,
    datasetVersion: "ts-real-ast-1",
    seed: 0,
    datasetHash: createHash("sha256")
      .update(JSON.stringify(dataset))
      .digest("hex"),
    files: 32,
    environment: {
      node: process.version,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryBytes: totalmem(),
      os: release(),
    },
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    scope:
      "actual TS compiler parsing and SQLite writes; observational; not 1000-file/10000-symbol UI compliance",
    scenarios,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!out || !process.argv.includes("--out"))
    throw new Error("--out required");
  const report = process.argv.includes("--benchmark")
    ? benchmarkAst()
    : verifyAst(resolve("."));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log("wrote " + out);
}
