import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { LocalDatabase } from "./db.js";
import { CodeIndex } from "./code-index.js";
import { scanPythonIndex, releasePythonIndex } from "./python-index.js";
import { summarize } from "./index-benchmark.js";
import { PYTHON_VERSION } from "@archsync/scanner/python";
export async function pythonBenchmark() {
  const sources = Array.from(
    { length: 32 },
    (_, i) => `def f${i}(n: int = 1) -> int:\n    return n + ${i}\n`,
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
      const root = mkdtempSync(join(tmpdir(), "python-bench-"));
      const db = new LocalDatabase(":memory:");
      const index = new CodeIndex(db);
      try {
        sources.forEach((s, j) => writeFileSync(join(root, `f${j}.py`), s));

        if (name !== "cold") await scanPythonIndex(root, "benchmark", index);
        const path = join(root, "f0.py");
        if (name === "edit")
          writeFileSync(path, sources[0]!.replace("+ 0", "+ 99"));
        if (name === "delete" || name === "restore") unlinkSync(path);
        if (name === "restore") {
          await scanPythonIndex(root, "benchmark", index);
          writeFileSync(path, sources[0]!);
        }
        if (name === "rename")
          writeFileSync(path, sources[0]!.replace("f0", "renamed"));
        if (name === "move") renameSync(path, join(root, "moved.py"));
        const cpu = process.cpuUsage();
        const r = await scanPythonIndex(
          root,
          "benchmark",
          index,
          name === "move" ? { "f0.py": "moved.py" } : {},
        );
        samples.push({
          parseMs: r.parseMs,
          indexMs: r.commitMs,
          totalMs: r.totalMs,
          cachedFiles: r.cachedFiles,
          cpu: process.cpuUsage(cpu),
          rss: process.memoryUsage().rss,
        });
      } finally {
        releasePythonIndex(index);
        db.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 10 });
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
    version: "python-ast-benchmark-1",
    seed: 0,
    datasetHash: createHash("sha256")
      .update(JSON.stringify(sources))
      .digest("hex"),
    files: 32,
    parserVersion: PYTHON_VERSION,
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    environment: {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memory: totalmem(),
      os: release(),
      node: process.version,
    },
    scope:
      "observational; empty AST cache/index each cold sample, WASM runtime initialization first sample only; no UI or 1000-file compliance claim",
    scenarios,
  };
}
export async function verifyPython() {
  const dir = mkdtempSync(join(tmpdir(), "python-proof-"));
  const db = new LocalDatabase(join(dir, "index.sqlite"));
  try {
    const r = await scanPythonIndex(
      resolve("packages/scanner/test/fixtures/python"),
      "fixture",
      new CodeIndex(db),
    );
    return {
      parserVersion: PYTHON_VERSION,
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      files: r.files,
      symbols: r.symbols.length,
      kinds: Object.fromEntries(
        [...new Set(r.symbols.map((s) => s.kind))].map((k) => [
          k,
          r.symbols.filter((s) => s.kind === k).length,
        ]),
      ),
      routes: r.routes,
      resolved: r.relations.filter((r) => r.strength === "resolved").length,
      unresolved: r.relations.filter((r) => r.strength !== "resolved").length,
      diagnostics: r.diagnostics,
      examples: r.symbols.filter((s) =>
        ["add", "total", "value"].includes(s.name),
      ),
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!out || !process.argv.includes("--out"))
    throw new Error("--out required");
  const r = process.argv.includes("--benchmark")
    ? await pythonBenchmark()
    : await verifyPython();
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(r, null, 2));
  console.log("wrote " + out);
}
