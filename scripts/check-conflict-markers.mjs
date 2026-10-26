#!/usr/bin/env node
/**
 * Guards tracked text sources against unresolved Git conflict markers.
 * Runs in CI (part of verify:pages pipeline) so a conflicted README/YAML/TS
 * can never reach main again (regression guard for the ef893bc README merge).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKERS = [/^<{7} /m, /^={7}$/m, /^>{7} /m];
const EXTENSIONS = new Set(['.md', '.yml', '.yaml', '.ts', '.tsx', '.json', '.mjs', '.sh']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.local', 'site-snapshots', 'coverage']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out);
    } else if (EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) {
      out.push(p);
    }
  }
  return out;
}

const problems = [];
for (const file of walk(root)) {
  const rel = file.slice(root.length + 1).replace(/\\/g, '/');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable: skip
  }
  for (const marker of MARKERS) {
    if (marker.test(text)) {
      const line = text.split('\n').findIndex((l) => marker.test(`${l}\n`)) + 1;
      problems.push(`${rel}:${line} 残留 Git 冲突标记 (${marker})`);
      break;
    }
  }
}

if (problems.length > 0) {
  console.error('发现未解决的 Git 冲突标记：');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('无 Git 冲突标记 ✓');
