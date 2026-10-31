import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDatabase } from "../src/db.js";
import { CodeIndex } from "../src/code-index.js";
import { scanPythonIndex } from "../src/python-index.js";
import { scanAstIndex } from "../src/ast-index.js";
it("offline real Python AST → SQLite, Unicode, imports/routes, UID, stale, restart and mixed languages", async () => {
  const root = mkdtempSync(join(tmpdir(), "rc5-python-"));
  let db = new LocalDatabase(join(root, "registry.sqlite"));
  try {
    mkdirSync(join(root, "包"));
    writeFileSync(
      join(root, "包/__init__.py"),
      'from .service import f\n__all__ = ["f"]\n',
    );
    const text =
      '# 中文注释\ndef f(x: int = 2) -> int:\n    """真实文档"""\n    return x + 1\n';
    writeFileSync(join(root, "包/service.py"), text);
    writeFileSync(
      join(root, "包/api.py"),
      `from .service import f as local_f
from fastapi import FastAPI
app = FastAPI()
@app.get('/hello')
async def endpoint(n: int = 1) -> int:
    return local_f(n)
class C:
    @staticmethod
    def same(x=1):
        return x
    @classmethod
    def build(cls):
        return cls()
class D:
    def same(self):
        return 2
def outer():
    def inner():
        return local_f()
    return inner()
def dynamic(x):
    return getattr(x, 'go')()
`,
    );
    writeFileSync(join(root, "main.ts"), "export function ts(){return 1;}");
    let index = new CodeIndex(db);
    let r = await scanPythonIndex(root, "p", index);
    const f = index
      .get("p", "包/service.py")!
      .symbols.find((s) => s.name === "f")!;
    expect(f).toMatchObject({
      startLine: 2,
      returnType: "int",
      docComment: '"""真实文档"""',
    });
    expect(f.parameters[0]).toMatchObject({
      name: "x",
      type: "int",
      defaultValue: "2",
    });
    expect(
      index
        .trustedRelations("p")
        .some((e) => e.kind === "calls" && e.targetUid === f.symbolUid),
    ).toBe(true);
    expect(r.routes).toBe(1);
    expect(r.relations.some((e) => e.reason === "dynamic_call")).toBe(true);
    expect(
      index.get("p", "包/api.py")!.symbols.filter((s) => s.name === "same"),
    ).toHaveLength(2);
    scanAstIndex(root, "p", index);
    await scanPythonIndex(root, "p", index);
    expect(index.get("p", "main.ts")?.status).toBe("fresh");
    expect(index.get("p", "包/service.py")?.status).toBe("fresh");
    writeFileSync(join(root, "包/service.py"), text.replace("+ 1", "+ 3"));
    await scanPythonIndex(root, "p", index);
    expect(
      index.get("p", "包/service.py")!.symbols.find((s) => s.name === "f")!
        .symbolUid,
    ).toBe(f.symbolUid);
    writeFileSync(join(root, "包/service.py"), "def f(:\n");
    await scanPythonIndex(root, "p", index);
    expect(index.get("p", "包/service.py")?.status).toBe("stale");
    expect(
      index.trustedRelations("p").some((e) => e.targetUid === f.symbolUid),
    ).toBe(false);
    writeFileSync(join(root, "包/service.py"), text);
    await scanPythonIndex(root, "p", index);
    db.close();
    db = new LocalDatabase(join(root, "registry.sqlite"));
    index = new CodeIndex(db);
    expect(
      index.get("p", "包/service.py")!.symbols.find((s) => s.name === "f")!
        .symbolUid,
    ).toBe(f.symbolUid);
    renameSync(join(root, "包/service.py"), join(root, "包/moved.py"));
    await scanPythonIndex(root, "p", index, { "包/service.py": "包/moved.py" });
    expect(
      index.get("p", "包/moved.py")!.symbols.find((s) => s.name === "f")!
        .symbolUid,
    ).toBe(f.symbolUid);
    writeFileSync(
      join(root, "包/moved.py"),
      text.replace("def f", "def renamed"),
    );
    await scanPythonIndex(root, "p", index);
    expect(
      index.get("p", "包/moved.py")!.symbols.find((s) => s.name === "renamed")!
        .symbolUid,
    ).toBe(f.symbolUid);
    unlinkSync(join(root, "包/moved.py"));
    await scanPythonIndex(root, "p", index);
    expect(index.get("p", "包/moved.py")?.status).toBe("deleted");
    r = await scanPythonIndex(root, "q", index);
    expect(index.get("q", "包/api.py")!.symbols[0]!.symbolUid).not.toBe(
      index.get("p", "包/api.py")!.symbols[0]!.symbolUid,
    );
    expect(r.diagnostics.length).toBeGreaterThan(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

it("Python packages, overloads, Flask routes, partial duplicates and read faults are explicit", async () => {
  const { PythonScanner } = await import("@archsync/scanner/python");
  const root = mkdtempSync(join(tmpdir(), "py-scope-"));
  const db = new LocalDatabase(":memory:");
  try {
    mkdirSync(join(root, "pkg/sub"), { recursive: true });
    writeFileSync(join(root, "pkg/__init__.py"), "");
    writeFileSync(join(root, "pkg/service.py"), "def f():\n    return 1\n");
    writeFileSync(join(root, "pkg/sub/__init__.py"), "");
    writeFileSync(
      join(root, "pkg/sub/use.py"),
      `from ..service import f as alias
from flask import Flask
app=Flask('fixture')
@app.route('/flask', methods=['POST'])
def route():
    return alias()
def outer():
    def inner():
        return alias()
    return inner()
`,
    );
    writeFileSync(
      join(root, "over.py"),
      `from typing import overload
@overload
def f(x:int)->int: ...
@overload
def f(x:str)->str: ...
def f(x):
    return x
`,
    );
    const index = new CodeIndex(db);
    const r = await scanPythonIndex(root, "p", index);
    expect(r.routes).toBe(1);
    expect(r.relations.some((e) => e.route?.method === "POST")).toBe(true);
    const nested = index
      .get("p", "pkg/sub/use.py")!
      .symbols.find((s) => s.qualifiedName === "outer.inner")!;
    expect(
      index.trustedRelations("p").some((e) => e.targetUid === nested.symbolUid),
    ).toBe(true);
    expect(index.get("p", "over.py")?.status).toBe("fresh");
    expect(
      new Set(index.get("p", "over.py")!.symbols.map((s) => s.symbolKey)).size,
    ).toBe(index.get("p", "over.py")!.symbols.length);
    writeFileSync(
      join(root, "dup.py"),
      "def f():\n    return 1\ndef f():\n    return 2\n",
    );
    await scanPythonIndex(root, "p", index);
    expect(index.get("p", "dup.py")?.status).toBe("partial");
    const faulty = new PythonScanner(() => {
      throw new Error("EACCES injected read failure");
    });
    try {
      const result = await faulty.scan(root, "p");
      index.applyBatch("p", result.updates);
      expect(index.get("p", "pkg/service.py")?.status).toBe("unavailable");
      expect(
        index.get("p", "pkg/service.py")!.symbols.some((s) => s.name === "f"),
      ).toBe(true);
      expect(index.trustedRelations("p")).toEqual([]);
    } finally {
      faulty.dispose();
    }
    await scanPythonIndex(root, "p", index);
    expect(index.get("p", "pkg/service.py")?.status).toBe("fresh");
    const scanner = new PythonScanner();
    try {
      const state = await scanner.scan(root, "test");
      expect(state.updates.some((f) => f.status === "partial")).toBe(true);
    } finally {
      scanner.dispose();
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

it("does not resolve parameter or assignment shadowing to a same-named global function", async () => {
  const root = mkdtempSync(join(tmpdir(), "py-shadow-"));
  const db = new LocalDatabase(":memory:");
  try {
    writeFileSync(
      join(root, "shadow.py"),
      "def f():\n    return 1\ndef caller(f):\n    return f()\ndef local():\n    f = unknown\n    return f()\n",
    );
    const index = new CodeIndex(db);
    await scanPythonIndex(root, "p", index);
    expect(
      index.trustedRelations("p").filter((r) => r.kind === "calls"),
    ).toEqual([]);
    expect(index.get("p", "shadow.py")?.status).toBe("fresh");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});
