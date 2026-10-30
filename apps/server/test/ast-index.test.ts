import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDatabase } from "../src/db.js";
import { CodeIndex } from "../src/code-index.js";
import { scanAstIndex } from "../src/ast-index.js";
it("real source → AST → SQLite → restart, edits, stale recovery, move and isolation", () => {
  const root = mkdtempSync(join(tmpdir(), "rc5-ast-"));
  let db = new LocalDatabase(join(root, "index.sqlite"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
          jsx: "react",
        },
      }),
    );
    const a =
      "/** documented */\nexport function f(x: number = 2): number { return x + 1; }";
    writeFileSync(join(root, "src/a.ts"), a);
    writeFileSync(
      join(root, "src/b.ts"),
      `import { f } from '@/a'; export const run = async () => f(3); export function dynamic(x: any) { return x.go(); }`,
    );
    writeFileSync(
      join(root, "src/model.ts"),
      `export interface User {name:string} export type Id = string; export class C { constructor(public n:number) {} m():number {return this.n;} } export function over(x:string):string; export function over(x:number):number; export function over(x:unknown){return x;} export default function* generator(){yield 1;}`,
    );
    writeFileSync(
      join(root, "src/view.tsx"),
      `export const View = () => <div onClick={() => 1}>hello</div>;`,
    );
    for (const ext of ["js", "jsx", "mjs", "cjs"])
      writeFileSync(
        join(root, `src/plain.${ext}`),
        `exports.fn = function named() { return 1; };`,
      );
    let index = new CodeIndex(db);
    const r = scanAstIndex(root, "p", index);
    expect(r.files).toBe(8);
    for (const ext of ["js", "jsx", "mjs", "cjs"])
      expect(
        index
          .get("p", `src/plain.${ext}`)!
          .symbols.some((s) => s.kind === "function" && s.name === "named"),
      ).toBe(true);
    const cls = index
      .get("p", "src/model.ts")!
      .symbols.find((s) => s.kind === "class")!;
    expect(
      index.get("p", "src/model.ts")!.symbols.find((s) => s.kind === "method")
        ?.parentSymbolUid,
    ).toBe(cls.symbolUid);
    const f = index.get("p", "src/a.ts")!.symbols.find((s) => s.name === "f")!;
    expect(f).toMatchObject({
      startLine: 2,
      returnType: "number",
      exported: true,
    });
    expect(f.parameters[0]).toMatchObject({
      name: "x",
      type: "number",
      defaultValue: "2",
    });
    expect(f.docComment).toContain("documented");
    expect(
      index
        .trustedRelations("p")
        .some((e) => e.kind === "calls" && e.targetUid === f.symbolUid),
    ).toBe(true);
    expect(index.get("p", "src/model.ts")!.symbols.map((s) => s.kind)).toEqual(
      expect.arrayContaining([
        "class",
        "method",
        "constructor",
        "interface",
        "type",
      ]),
    );
    expect(
      new Set(index.get("p", "src/model.ts")!.symbols.map((s) => s.symbolKey))
        .size,
    ).toBe(index.get("p", "src/model.ts")!.symbols.length);
    expect(
      index
        .get("p", "src/view.tsx")!
        .symbols.filter((s) => s.kind === "function"),
    ).toHaveLength(1);
    expect(
      index
        .get("p", "src/b.ts")!
        .relations.some((e) => e.strength !== "resolved"),
    ).toBe(true);
    db.close();
    db = new LocalDatabase(join(root, "index.sqlite"));
    index = new CodeIndex(db);
    expect(
      index.get("p", "src/a.ts")!.symbols.find((s) => s.name === "f")!
        .symbolUid,
    ).toBe(f.symbolUid);
    writeFileSync(join(root, "src/a.ts"), a.replace("x + 1", "x + 2"));
    scanAstIndex(root, "p", index);
    expect(
      index.get("p", "src/a.ts")!.symbols.find((s) => s.name === "f")!
        .symbolUid,
    ).toBe(f.symbolUid);
    writeFileSync(join(root, "src/a.ts"), "export function f( {");
    scanAstIndex(root, "p", index);
    expect(index.get("p", "src/a.ts")!.status).toBe("stale");
    expect(
      index.trustedRelations("p").some((e) => e.targetUid === f.symbolUid),
    ).toBe(false);
    writeFileSync(join(root, "src/a.ts"), a);
    scanAstIndex(root, "p", index);
    expect(index.get("p", "src/a.ts")!.status).toBe("fresh");
    renameSync(join(root, "src/a.ts"), join(root, "src/moved.ts"));
    scanAstIndex(root, "p", index, { "src/a.ts": "src/moved.ts" });
    expect(index.get("p", "src/a.ts")!.status).toBe("deleted");
    expect(
      index.get("p", "src/moved.ts")!.symbols.find((s) => s.name === "f")!
        .symbolUid,
    ).toBe(f.symbolUid);
    scanAstIndex(root, "q", index);
    expect(
      index.get("q", "src/moved.ts")!.symbols.find((s) => s.name === "f")!
        .symbolUid,
    ).not.toBe(f.symbolUid);
    writeFileSync(
      join(root, "src/moved.ts"),
      readFileSync(join(root, "src/moved.ts"), "utf8").replace(
        "function f",
        "function renamed",
      ),
    );
    scanAstIndex(root, "p", index);
    expect(
      index.get("p", "src/moved.ts")!.symbols.find((s) => s.name === "renamed")!
        .symbolUid,
    ).toBe(f.symbolUid);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

it("does not reuse modified declaration identity across split and merge", () => {
  const root = mkdtempSync(join(tmpdir(), "ast-split-"));
  const db = new LocalDatabase(":memory:");
  try {
    const index = new CodeIndex(db);
    const path = join(root, "a.ts");
    writeFileSync(path, "export function f(){ const x=1; return x+2; }");
    scanAstIndex(root, "p", index);
    const uid = index
      .get("p", "a.ts")!
      .symbols.find((s) => s.name === "f")!.symbolUid;
    writeFileSync(
      path,
      "export function f(){ return g(); } export function g(){return 3;}",
    );
    scanAstIndex(root, "p", index);
    expect(
      index.get("p", "a.ts")!.symbols.every((s) => s.symbolUid !== uid),
    ).toBe(true);
    const before = index
      .get("p", "a.ts")!
      .symbols.filter((s) => s.kind === "function")
      .map((s) => s.symbolUid);
    writeFileSync(path, "export function f(){ return 4; }");
    scanAstIndex(root, "p", index);
    expect(before).not.toContain(
      index.get("p", "a.ts")!.symbols.find((s) => s.name === "f")!.symbolUid,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});
