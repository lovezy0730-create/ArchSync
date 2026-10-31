import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDatabase } from '../src/db.js';
import { CodeIndex } from '../src/code-index.js';
import { scanAstIndex } from '../src/ast-index.js';
import { releasePythonIndex, scanPythonIndex } from '../src/python-index.js';

it('keeps independent parser caches for different project roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archsync-cache-'));
  const db = new LocalDatabase(':memory:');
  const index = new CodeIndex(db);
  try {
    for (const name of ['a', 'b']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'main.ts'), 'export function f() { return 1; }');
      writeFileSync(join(root, name, 'main.py'), 'def f():\n    return 1\n');
    }
    scanAstIndex(join(root, 'a'), 'a', index);
    await scanPythonIndex(join(root, 'a'), 'a', index);
    scanAstIndex(join(root, 'b'), 'b', index);
    await scanPythonIndex(join(root, 'b'), 'b', index);
    expect(scanAstIndex(join(root, 'a'), 'a', index).cachedFiles).toBe(1);
    expect((await scanPythonIndex(join(root, 'a'), 'a', index)).cachedFiles).toBe(1);
  } finally {
    releasePythonIndex(index);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
