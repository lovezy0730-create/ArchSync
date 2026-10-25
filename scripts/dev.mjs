#!/usr/bin/env node
/**
 * One-command dev launcher: (re)builds the web app, then starts the Fastify
 * server which serves API + WebSocket + built frontend on one port.
 *
 * The rebuild is unconditional on purpose: a previous `pnpm build:pages` can
 * leave a /ArchSync/-base static bundle in dist/, which would break the
 * server-rooted local mode. Pass --no-build to skip (dangerous unless you
 * know dist is a plain build).
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipBuild = process.argv.includes('--no-build');

if (!skipBuild) {
  console.log('[archsync] building web app (local server mode)…');
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
