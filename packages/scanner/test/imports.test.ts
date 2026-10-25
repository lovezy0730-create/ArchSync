import { describe, expect, it } from 'vitest';
import {
  analyzeImports,
  extractImportSpecifiers,
  isAnalyzable,
  moduleDependencyEdges,
  resolveSpecifier,
} from '../src/imports.js';

const files = [
  { path: 'src/a/main.ts', content: `import { x } from './helper';\nimport { y } from '../b/api';\nimport React from 'react';\nimport fs from 'node:fs';\nexport * from './legacy';` },
  { path: 'src/a/helper.ts', content: `export const x = 1;` },
  { path: 'src/a/legacy.ts', content: `export const old = true;` },
  { path: 'src/b/api.ts', content: `import type { Note } from './types';\nconst dyn = await import('./lazy');` },
  { path: 'src/b/types.ts', content: `export interface Note { id: string }` },
  { path: 'src/b/lazy.ts', content: `export const lazy = 1;` },
  { path: 'src/c/orphan.ts', content: `import { missing } from './not-there';` },
];

describe('extractImportSpecifiers', () => {
  it('covers import/export/require/dynamic-import forms', () => {
    const specifiers = extractImportSpecifiers(
      `import a from 'a';\nimport 'side-effect';\nexport { b } from 'b';\nconst c = require('c');\nconst d = import('d');\nimport { e } from "double-quotes";`,
    );
    expect(specifiers.sort()).toEqual(['a', 'b', 'c', 'd', 'double-quotes', 'side-effect']);
  });
});

describe('resolveSpecifier', () => {
  const fileSet = new Set(['src/a/main.ts', 'src/a/helper.ts', 'src/a/util/index.ts', 'src/a/data.json']);

  it('completes extensions and index files without guessing', () => {
    expect(resolveSpecifier('src/a/main.ts', './helper', fileSet)).toBe('src/a/helper.ts');
    expect(resolveSpecifier('src/a/main.ts', './util', fileSet)).toBe('src/a/util/index.ts');
    expect(resolveSpecifier('src/a/main.ts', './data', fileSet)).toBe('src/a/data.json');
    expect(resolveSpecifier('src/a/main.ts', './ghost', fileSet)).toBeNull();
  });

  it('normalizes ../ and windows separators', () => {
    expect(resolveSpecifier('src\\a\\main.ts', '../a/helper', fileSet)).toBe('src/a/helper.ts');
  });
});

describe('analyzeImports', () => {
  const analysis = analyzeImports(files);

  it('resolves relative imports to concrete files', () => {
    expect(analysis.resolved.get('src/a/main.ts')).toEqual(
      new Set(['src/a/helper.ts', 'src/b/api.ts', 'src/a/legacy.ts']),
    );
    expect(analysis.resolved.get('src/b/api.ts')).toEqual(
      new Set(['src/b/types.ts', 'src/b/lazy.ts']),
    );
  });

  it('keeps bare specifiers external instead of inventing module edges', () => {
    expect(analysis.external.get('src/a/main.ts')).toEqual(new Set(['react', 'node:fs']));
    expect(analysis.resolved.get('src/a/main.ts')?.has('react')).toBeFalsy();
  });

  it('records unresolved relative imports as unknown, not as edges', () => {
    expect(analysis.unresolved.get('src/c/orphan.ts')).toEqual(new Set(['./not-there']));
    expect(analysis.resolved.has('src/c/orphan.ts')).toBeFalsy();
  });

  it('ignores non-analyzable files and oversized sources', () => {
    expect(isAnalyzable('a.py')).toBe(false);
    expect(isAnalyzable('a.tsx')).toBe(true);
    const big = analyzeImports([{ path: 'big.ts', content: 'x'.repeat(256 * 1024 + 10) }]);
    expect(big.resolved.size).toBe(0);
  });
});

describe('moduleDependencyEdges', () => {
  it('collapses file edges into module edges, skipping intra-module imports', () => {
    const analysis = analyzeImports(files);
    const moduleOf = (path: string): string | null => {
      if (path.startsWith('src/a/')) return 'mod-a';
      if (path.startsWith('src/b/')) return 'mod-b';
      return null;
    };
    const edges = moduleDependencyEdges(analysis, moduleOf);
    expect(edges).toContainEqual({ source: 'mod-a', target: 'mod-b' });
    // helper/legacy live in the same module → no self edge
    expect(edges).not.toContainEqual({ source: 'mod-a', target: 'mod-a' });
    expect(edges).not.toContainEqual({ source: 'mod-b', target: 'mod-b' });
  });
});
