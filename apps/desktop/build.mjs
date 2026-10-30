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

fs.copyFileSync(path.join(desktop,'src','preload.cjs'),path.join(distElectron,'preload.cjs'));

// 2. web production build
run('pnpm', ['--filter', '@archsync/web', 'build']);

// 2b. bundle the Fastify agent into a standalone CJS unit runnable by any
// Node ≥22.5 runtime (Electron utilityProcess / system node) — no tsx/pnpm.
fs.mkdirSync(path.join(distElectron, 'agent'), { recursive: true });
await esbuildBuild({
  entryPoints: [path.join(root, 'apps', 'server', 'src', 'index.ts')],
  outfile: path.join(distElectron, 'agent', 'agent.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'error',
  // CJS 输出下 import.meta.url 不可用：banner 注入等价值并 define 替换；
  // ARCHSYNC_AGENT_ENTRY=1 让 index.ts 的入口检测在 bundle 内触发启动
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  define: {
    'import.meta.url': '__import_meta_url',
    'process.env.ARCHSYNC_AGENT_ENTRY': '"1"',
  },
});

// 3. desktop package
if (process.argv.includes('--package')) {
  run('pnpm', ['--filter', '@archsync/desktop', 'exec', 'electron-builder', '--win', 'portable', 'nsis', `--config=${path.join(desktop, 'electron-builder.yml')}`]);
} else if (process.argv.includes('--run')) {
  run('pnpm', ['--filter', '@archsync/desktop', 'exec', 'electron', '.']);
}
