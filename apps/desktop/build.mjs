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

const root = path.join(__dirname, '..');
const desktop = path.join(__dirname, '.');
const distElectron = path.join(desktop, 'dist-electron');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`[desktop] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

// 1. bundle main process
fs.mkdirSync(distElectron, { recursive: true });
run('pnpm', ['exec', 'esbuild', 'apps/desktop/src/main.cjs', '--bundle', `--outfile=${path.join(distElectron, 'main.cjs')}`, '--platform=node', '--format=cjs', '--external:electron']);

// 2. web production build
run('pnpm', ['--filter', '@archsync/web', 'build']);

// 3. desktop package
if (process.argv.includes('--package')) {
  run('pnpm', ['--filter', '@archsync/desktop', 'exec', 'electron-builder', '--win', 'portable', 'nsis', `--config=${path.join(desktop, 'electron-builder.yml')}`]);
} else if (process.argv.includes('--run')) {
  run('pnpm', ['--filter', '@archsync/desktop', 'exec', 'electron', '.']);
}
