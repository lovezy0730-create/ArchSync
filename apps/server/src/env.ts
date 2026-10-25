import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal .env loader — no dependency, no interpolation, values never logged. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface ServerEnv {
  host: string;
  port: number;
  databasePath: string;
  githubToken: string | null;
  devAuthMode: 'mock' | 'off';
  presenceTtlSeconds: number;
  watchDebounceMs: number;
  nodeEnv: string;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function loadEnv(repoRoot: string): ServerEnv {
  loadDotEnv(join(repoRoot, '.env'));
  const host = process.env.HOST ?? '127.0.0.1';
  const devAuthMode = (process.env.DEV_AUTH_MODE ?? 'mock') === 'off' ? 'off' : 'mock';
  // Mock identity is only ever allowed on loopback bindings (see CONSTRUCTION_PLAN §7.1).
  if (devAuthMode === 'mock' && !isLoopbackHost(host)) {
    throw new Error(
      `DEV_AUTH_MODE=mock 仅允许在回环地址使用，当前 HOST=${host}。请设置 HOST=127.0.0.1 或 DEV_AUTH_MODE=off。`,
    );
  }
  return {
    host,
    port: Number(process.env.PORT ?? 4310),
    databasePath: process.env.DATABASE_PATH ?? './.local/archsync-state.json',
    githubToken: process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.length > 0 ? process.env.GITHUB_TOKEN : null,
    devAuthMode,
    presenceTtlSeconds: Number(process.env.PRESENCE_TTL_SECONDS ?? 45),
    watchDebounceMs: Number(process.env.WATCH_DEBOUNCE_MS ?? 500),
    nodeEnv: process.env.NODE_ENV ?? 'development',
  };
}
