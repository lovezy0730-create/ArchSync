#!/usr/bin/env node
/**
 * One-command dev launcher: builds the web app (first run), then starts the
 * Fastify server which serves API + WebSocket + built frontend on one port.
 * An optional `--rebuild` flag forces a fresh web build.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(root, 'apps', 'web', 'dist', 'index.html');
const forceRebuild = process.argv.includes('--rebuild');

if (forceRebuild || !existsSync(distIndex)) {
  console.log('[archsync] building web app…');
  const build = spawnSync('pnpm', ['--filter', '@archsync/web', 'build'], {
    cwd: root, stdio: 'inherit', shell: true,
  });
  if (build.status !== 0) {
    console.error('[archsync] web build failed');
    process.exit(build.status ?? 1);
  }
}

console.log('[archsync] starting server…');
const server = spawnSync('pnpm', ['exec', 'tsx', 'apps/server/src/index.ts'], {
  cwd: root, stdio: 'inherit', shell: true,
});
process.exit(server.status ?? 0);
