/**
 * Desktop build script.
 *
 * Steps:
 * 1. bundle the Electron main process with esbuild (cjs, external electron)
 * 2. run the web production build (apps/web/dist)
 * 3. optionally package with electron-builder (portable + nsis targets)
 *
 * Usage: node build.mjs [--run | --package]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..'); // apps/desktop → repo root
const desktop = here;
const distElectron = path.join(desktop, 'dist-electron');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`[desktop] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

// 1. bundle main process via the esbuild JS API (no platform-specific binary shim)
fs.mkdirSync(distElectron, { recursive: true });
// esbuild 在 pnpm 虚拟存储中，从本包 createRequire 解析真实路径
const { createRequire } = await import('node:module');
const esbuild = (createRequire(path.join(desktop, 'package.json')))('esbuild');
const { build: esbuildBuild } = esbuild;
await esbuildBuild({
  entryPoints: [path.join(root, 'apps', 'desktop', 'src', 'main.cjs')],
  outfile: path.join(distElectron, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'info',
});

// 2. web production build
run('pnpm', ['--filter', '@archsync/web', 'build']);

// 3. desktop package
if (process.argv.includes('--package')) {
  run('pnpm', ['--filter', '@archsync/desktop', 'exec', 'electron-builder', '--win', 'portable', 'nsis', `--config=${path.join(desktop, 'electron-builder.yml')}`]);
} else if (process.argv.includes('--run')) {
  run('pnpm', ['--filter', '@archsync/desktop', 'exec', 'electron', '.']);
}
