import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDatabase } from "../src/db.js";
import { CodeIndex, type FileUpdate } from "../src/code-index.js";
import { matchSymbols, symbolKey } from "@archsync/scanner/identity";
import {
  summarize,
  generateDataset,
  runBenchmark,
} from "../src/index-benchmark.js";

it("does not add history for an unchanged fresh scan, but records configuration changes", () => {
  const db = new LocalDatabase(":memory:");
  try {
    const index = new CodeIndex(db);
    index.applyBatch("p", [file()]);
    index.applyBatch("p", [{ ...file(), scannedAt: "2026-10-31T00:00:00Z" }]);
    expect(index.history("p", "src/a.ts")).toHaveLength(1);
    index.applyBatch("p", [{ ...file(), configVersion: "2" }]);
    expect(index.history("p", "src/a.ts")).toHaveLength(2);
  } finally {
    db.close();
  }
});
const draft = (
  name = "f",
  fingerprint = "body",
  filePath = "src/a.ts",
  startLine = 1,
) => ({
  projectId: "p",
  moduleId: "m",
  filePath,
  language: "typescript" as const,
  kind: "function" as const,
  name,
  qualifiedName: name,
  signature: `${name}()`,
  overload: "",
  parameters: [],
  returnType: null,
  exported: true,
  visibility: "public" as const,
  startLine,
  endLine: startLine + 2,
  parentSymbolUid: null,
  decorators: [],
  modifiers: [],
  docComment: null,
  sourceHash: "hash",
  parserVersion: "fixture-1",
  scannedAt: "2026-10-30T00:00:00Z",
  analysisStatus: "resolved" as const,
  evidence: [],
  fingerprint,
});
const file = (
  symbols = [draft()],
  status: FileUpdate["status"] = "fresh",
  hash: string | null = "hash",
): FileUpdate => ({
  projectId: "p",
  filePath: "src/a.ts",
  language: "typescript",
  moduleId: "m",
  contentHash: hash,
  parserVersion: "fixture-1",
  configVersion: "1",
  scannedAt: "2026-10-30T00:00:00Z",
  status,
  diagnostics: [],
  symbols,
  relations: [],
});
describe("AC17 deterministic identity foundation (not AST)", () => {
  it.each(["line", "move", "rename"])(
    "preserves unique proven identity: %s",
    (mode) => {
      const old = matchSymbols([], [draft()]);
      const next = draft(
        mode === "rename" ? "renamed" : "f",
        "body",
        mode === "move" ? "src/b.ts" : "src/a.ts",
        mode === "line" ? 20 : 1,
      );
      const matched = matchSymbols(old, [next]);
      expect(matched[0]?.symbolUid).toBe(old[0]?.symbolUid);
      expect(matched[0]?.identity.reason).not.toBe("new");
    },
  );
  it("does not inherit annotations through ambiguous duplicated bodies", () => {
    const old = matchSymbols([], [draft("a"), draft("b")]);
    const next = matchSymbols(old, [draft("c")]);
    expect(old.map((s) => s.symbolUid)).not.toContain(next[0]?.symbolUid);
    expect(next[0]?.possiblePredecessors).toHaveLength(2);
  });
  it.each(["split", "merge"])(
    "does not equate changed structures: %s",
    (mode) => {
      const old = matchSymbols(
        [],
        mode === "split"
          ? [draft("f", "AB")]
          : [draft("a", "A"), draft("b", "B")],
      );
      const next = matchSymbols(
        old,
        mode === "split"
          ? [draft("f", "A"), draft("g", "B")]
          : [draft("f", "AB")],
      );
      expect(
        next.every((n) => old.every((o) => o.symbolUid !== n.symbolUid)),
      ).toBe(true);
    },
  );
  it("overloads have distinct keys and rejects duplicate declarations", () => {
    const a = { ...draft(), overload: "string" },
      b = { ...draft(), overload: "number" };
    expect(symbolKey(a)).not.toBe(symbolKey(b));
    expect(() => matchSymbols([], [a, a])).toThrow();
  });
});
describe("AC18 persistent file transactions", () => {
  it("stale/unavailable preserve last success; partial not trusted; repair and deletion invalidate edges", () => {
    const db = new LocalDatabase(":memory:");
    try {
      const index = new CodeIndex(db);
      const input = file();
      input.relations = [
        {
          kind: "calls",
          sourceKey: symbolKey(draft()),
          targetKey: symbolKey(draft()),
          strength: "resolved",
          evidence: [],
        },
      ];
      index.applyBatch("p", [input]);
      const uid = index.get("p", "src/a.ts")!.symbols[0]!.symbolUid;
      expect(index.trustedRelations("p")).toHaveLength(1);
      for (const status of ["stale", "unavailable"] as const) {
        index.applyBatch("p", [file([], status, "broken")]);
        const state = index.get("p", "src/a.ts")!;
        expect(state.symbols[0]?.symbolUid).toBe(uid);
        expect(state.lastSuccessfulHash).toBe("hash");
        expect(state.contentHash).toBe("broken");
        expect(index.trustedRelations("p")).toHaveLength(0);
      }
      index.applyBatch("p", [file([draft("partial")], "partial")]);
      expect(index.trustedRelations("p")).toEqual([]);
      index.applyBatch("p", [input]);
      expect(index.get("p", "src/a.ts")?.status).toBe("fresh");
      index.applyBatch("p", [file([], "deleted", null)]);
      expect(index.get("p", "src/a.ts")?.symbols).toEqual([]);
      expect(index.history("p", "src/a.ts").length).toBe(6);
    } finally {
      db.close();
    }
  });
  it("rolls back an entire invalid batch without emptying prior state", () => {
    const db = new LocalDatabase(":memory:");
    try {
      const index = new CodeIndex(db);
      index.applyBatch("p", [file()]);
      expect(() =>
        index.applyBatch("p", [
          file([draft("new")]),
          { ...file(), filePath: "../escape" },
        ]),
      ).toThrow();
      expect(index.get("p", "src/a.ts")?.symbols[0]?.name).toBe("f");
    } finally {
      db.close();
    }
  });
  it("keeps links to unchanged files and atomically moves a file without UID duplication", () => {
    const db = new LocalDatabase(":memory:");
    try {
      const index = new CodeIndex(db);
      const a = file();
      const b = {
        ...file([draft("g", "other", "src/b.ts")]),
        filePath: "src/b.ts",
      };
      a.relations = [
        {
          kind: "calls",
          sourceKey: symbolKey(draft()),
          targetKey: symbolKey(b.symbols[0]!),
          strength: "resolved",
          evidence: [],
        },
      ];
      index.applyBatch("p", [a, b]);
      const uid = index.get("p", "src/a.ts")!.symbols[0]!.symbolUid;
      index.applyBatch("p", [a]);
      expect(index.trustedRelations("p")).toHaveLength(1);
      const moved = {
        ...a,
        filePath: "src/moved.ts",
        symbols: [draft("f", "body", "src/moved.ts")],
        relations: [],
      };
      index.applyBatch("p", [file([], "deleted", null), moved], {
        "src/a.ts": "src/moved.ts",
      });
      expect(index.get("p", "src/moved.ts")?.symbols[0]?.symbolUid).toBe(uid);
      expect(index.get("p", "src/a.ts")?.symbols).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("rolls back writes already made when a later SQL insert fails", () => {
    const db = new LocalDatabase(":memory:");
    try {
      const index = new CodeIndex(db);
      index.applyBatch("p", [file()]);
      db.exec(
        "CREATE TRIGGER reject_b BEFORE INSERT ON code_index_history WHEN NEW.file_path='src/b.ts' BEGIN SELECT RAISE(ABORT,'fixture injected failure'); END",
      );
      expect(() =>
        index.applyBatch("p", [
          file([draft("changed", "new")]),
          { ...file([draft("g", "g", "src/b.ts")]), filePath: "src/b.ts" },
        ]),
      ).toThrow("fixture injected failure");
      expect(index.get("p", "src/a.ts")?.revision).toBe(1);
      expect(index.history("p", "src/a.ts")).toHaveLength(1);
      expect(index.get("p", "src/b.ts")).toBeNull();
    } finally {
      db.close();
    }
  });
  it("restores projects and history on restart and preserves legacy JSON/SQLite data on migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc5-index-"));
    const path = join(dir, "registry.sqlite");
    let db = new LocalDatabase(path);
    try {
      db.prepare(
        "INSERT INTO github_cache VALUES ('legacy','test','{}','now')",
      ).run();
      db.exec(
        "DROP TABLE IF EXISTS code_index_files; DROP TABLE IF EXISTS code_index_history; DELETE FROM schema_migrations WHERE version=3",
      );
      db.close();
      writeFileSync(join(dir, "state.json"), "legacy-json");
      db = new LocalDatabase(path);
      let index = new CodeIndex(db);
      index.applyBatch("p", [file()]);
      index.applyBatch("q", [
        {
          ...file(),
          projectId: "q",
          symbols: [{ ...draft(), projectId: "q" }],
        },
      ]);
      const uid = index.get("p", "src/a.ts")?.symbols[0]?.symbolUid;
      db.close();
      db = new LocalDatabase(path);
      index = new CodeIndex(db);
      expect(index.get("p", "src/a.ts")?.symbols[0]?.symbolUid).toBe(uid);
      expect(index.get("q", "src/a.ts")?.symbols[0]?.symbolUid).not.toBe(uid);
      expect(db.prepare("SELECT * FROM github_cache").all()).toHaveLength(1);
      expect(readFileSync(join(dir, "state.json"), "utf8")).toBe("legacy-json");
      expect(
        db
          .prepare("SELECT version FROM schema_migrations WHERE version=3")
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    }
  });
});
describe("AC19 measurement mechanics only", () => {
  it("computes nearest-rank P50/P95 and validates samples", () => {
    expect(summarize([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({
      p50: 5,
      p95: 10,
      min: 1,
      max: 10,
      count: 10,
    });
    expect(() => summarize([1])).toThrow();
    expect(() => summarize(Array(10).fill(NaN))).toThrow();
  });
  it("locks seed/version/hash and separates cold and incremental samples", async () => {
    expect(generateDataset(7)).toEqual(generateDataset(7));
    expect(generateDataset(7).hash).not.toBe(generateDataset(8).hash);
    const report = await runBenchmark(7, 10);
    expect(report.scenarios.map((s) => s.name)).toEqual([
      "cold-index",
      "incremental-index",
    ]);
    expect(report.scenarios.every((s) => s.samples.length === 10)).toBe(true);
    expect(report.environment.cpuModel).toBeTruthy();
    expect(report.gitSha).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe("runtime contract boundaries", () => {
  it("rejects invalid evidence and definition ranges and keeps uncertain annotation ownership separate", async () => {
    const { CodeSymbolSchema, RelativeSourcePathSchema } = await import(
      "@archsync/contracts"
    );
    const old = matchSymbols([], [draft("a"), draft("b")]);
    const next = matchSymbols(old, [draft("c")]);
    const notes = new Map([[old[0]!.symbolUid, "approved"]]);
    expect(notes.get(next[0]!.symbolUid)).toBeUndefined();
    expect(notes.get(old[0]!.symbolUid)).toBe("approved");
    expect(CodeSymbolSchema.safeParse({ ...old[0], endLine: 0 }).success).toBe(
      false,
    );
    expect(RelativeSourcePathSchema.safeParse("C:/secrets.ts").success).toBe(
      false,
    );
  });
});
