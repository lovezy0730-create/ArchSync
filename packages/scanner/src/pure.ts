/**
 * Browser-safe subset of the scanner: pure path matching with zero Node.js
 * imports, used by the static web bundle for local YAML import previews.
 */
import picomatch from 'picomatch';

const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.local',
  'coverage',
  '.archsync-cache',
]);

const IGNORED_FILE_PATTERN = /^(\.env|\.DS_Store|Thumbs\.db)/;

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isIgnoredPath(posixPath: string): boolean {
  const segments = posixPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (IGNORED_DIR_NAMES.has(seg)) return true;
  }
  const file = segments[segments.length - 1] ?? '';
  return IGNORED_FILE_PATTERN.test(file);
}

export function matchPaths(globs: string[], files: string[]): string[] {
  if (globs.length === 0) return [];
  const matchers = globs.map((g) => picomatch(g, { dot: false }));
  return files
    .filter((f) => isIgnoredPath(f) === false)
    .filter((f) => matchers.some((m) => m(f)))
    .sort();
}
