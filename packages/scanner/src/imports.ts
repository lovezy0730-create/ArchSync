/**
 * Conservative TypeScript/JavaScript import analysis.
 *
 * Design rules (truthfulness first):
 * - Only RELATIVE imports (`./x`, `../y`) are resolved to module edges.
 *   Bare package specifiers (react, node:fs, …) are external, never mapped.
 * - A resolution is only emitted when the target file exists in the provided
 *   file set (with extension/index completion). Anything else is recorded as
 *   unresolved — never guessed.
 * - The parser is intentionally regex-based: it covers the overwhelmingly
 *   common `import … from`, `export … from`, `require()`, `import()` forms
 *   without pulling a full AST. Files that cannot be parsed yield zero
 *   edges rather than fabricated ones.
 */
import { toPosix } from './pure.js';

const IMPORT_PATTERNS: RegExp[] = [
  /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g,
  /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const ANALYZABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const RESOLUTION_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
export const MAX_ANALYZE_BYTES = 256 * 1024;

export interface ImportAnalysis {
  /** relative posix path -> resolved relative import targets (posix) */
  resolved: Map<string, Set<string>>;
  /** import specifiers we deliberately do not map (bare/external) */
  external: Map<string, Set<string>>;
  /** relative specifiers that could not be resolved against the file set */
  unresolved: Map<string, Set<string>>;
}

/**
 * Workspace package aliases: monorepo-internal imports use package names
 * (`@archsync/graph`) even though they resolve to local files. The alias
 * table maps specifier -> entry file relative to the workspace root.
 */
export type PackageAliases = Map<string, string>;

export function isAnalyzable(path: string): boolean {
  return ANALYZABLE_EXTENSIONS.has(extensionOf(path));
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot) : '';
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function joinPosix(dir: string, rel: string): string {
  const combined = dir.length === 0 ? rel : `${dir}/${rel}`;
  const parts: string[] = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

export function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.add(match[1]!);
    }
  }
  return [...specifiers];
}

/** Resolve a relative specifier against a file set with extension completion. */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  const base = joinPosix(dirname(toPosix(fromFile)), specifier);
  for (const ext of RESOLUTION_EXTENSIONS) {
    if (fileSet.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLUTION_EXTENSIONS) {
    const indexPath = `${base}/index${ext}`;
    if (fileSet.has(indexPath)) return indexPath;
  }
  return null;
}

export interface AnalyzableFile {
  path: string;
  content: string;
}

export function analyzeImports(files: AnalyzableFile[], packageAliases: PackageAliases = new Map()): ImportAnalysis {
  const fileSet = new Set(files.map((f) => toPosix(f.path)));
  const analysis: ImportAnalysis = {
    resolved: new Map(),
    external: new Map(),
    unresolved: new Map(),
  };

  for (const file of files) {
    const from = toPosix(file.path);
    if (!isAnalyzable(from) || file.content.length > MAX_ANALYZE_BYTES) continue;
    for (const specifier of extractImportSpecifiers(file.content)) {
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
      if (!isRelative) {
        const aliasedTarget = packageAliases.get(specifier);
        if (aliasedTarget !== undefined && fileSet.has(aliasedTarget)) {
          if (aliasedTarget !== from) push(analysis.resolved, from, aliasedTarget);
          continue;
        }
        // subpath imports like @scope/pkg/sub are not aliased here: treat as external
        push(analysis.external, from, specifier);
        continue;
      }
      const target = resolveSpecifier(from, specifier, fileSet);
      if (target === null) {
        push(analysis.unresolved, from, specifier);
        continue;
      }
      if (target === from) continue; // self-import carries no dependency edge
      push(analysis.resolved, from, target);
    }
  }
  return analysis;
}

function push(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/** Collapse file-level imports into module-level dependency edges. */
export function moduleDependencyEdges(
  analysis: ImportAnalysis,
  moduleOf: (filePath: string) => string | null,
): Array<{ source: string; target: string }> {
  const edges = new Set<string>();
  for (const [fromFile, targets] of analysis.resolved) {
    const sourceModule = moduleOf(fromFile);
    if (sourceModule === null) continue;
    for (const toFile of targets) {
      const targetModule = moduleOf(toFile);
      if (targetModule === null || targetModule === sourceModule) continue;
      edges.add(`${sourceModule}->${targetModule}`);
    }
  }
  return [...edges].map((e) => {
    const [source, target] = e.split('->');
    return { source: source!, target: target! };
  });
}
