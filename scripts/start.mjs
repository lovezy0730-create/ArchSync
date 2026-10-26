#!/usr/bin/env node
/**
 * Production-style launcher: verifies the web bundle exists, then starts the
 * Fastify server (REST + WS + static frontend) on a single port.
 * Configuration comes from environment / .env — see .env.example and docs/deploy.md.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(root, 'apps', 'web', 'dist', 'index.html');

if (!existsSync(distIndex)) {
  console.log('[archsync] 未找到前端构建产物，正在构建 (pnpm build)…');
  const build = spawnSync('pnpm', ['--filter', '@archsync/web', 'build'], {
    cwd: root, stdio: 'inherit', shell: true,
  });
  if (build.status !== 0) {
    console.error('[archsync] 前端构建失败，无法启动。请先运行: pnpm install && pnpm build');
    process.exit(build.status ?? 1);
  }
}

const server = spawnSync('pnpm', ['exec', 'tsx', 'apps/server/src/index.ts'], {
  cwd: root, stdio: 'inherit', shell: true,
});
process.exit(server.status ?? 0);
