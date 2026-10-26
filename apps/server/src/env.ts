import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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

/**
 * Auth modes:
 * - 'mock': display-name-only identity, hardcoded to loopback bindings (dev demo).
 * - 'code': shared access code via AUTH_CODE; visitors exchange the code for an
 *   HttpOnly session cookie. Allowed on any host — this is the minimal real
 *   auth that makes non-loopback deployment possible.
 * - 'off': no auth at all; loopback only.
 */
export type AuthMode = 'mock' | 'code' | 'off';

export interface ServerEnv {
  host: string;
  port: number;
  databasePath: string;
  githubToken: string | null;
  authMode: AuthMode;
  authCode: string | null;
  authCodeMinLength: number;
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
  const authCodeRaw = process.env.AUTH_CODE?.trim() ?? '';
  const authCode = authCodeRaw.length > 0 ? authCodeRaw : null;
  const devAuthRaw = (process.env.DEV_AUTH_MODE ?? 'mock') === 'off' ? 'off' : 'mock';

  let authMode: AuthMode;
  if (authCode !== null) {
    authMode = 'code';
  } else {
    authMode = devAuthRaw;
  }

  // Safety envelope (CONSTRUCTION_PLAN §7.1): unauthenticated modes must never
  // leave the loopback; only the code mode may bind a real interface.
  if (authMode !== 'code' && !isLoopbackHost(host)) {
    throw new Error(
      `当前鉴权模式 "${authMode}" 仅允许绑定回环地址，当前 HOST=${host}。` +
        `请设置 AUTH_CODE=<访问码> 以启用访问码鉴权，或改用 HOST=127.0.0.1。`,
    );
  }
  if (authMode === 'code' && authCode !== null && authCode.length < 8) {
    throw new Error('AUTH_CODE 至少需要 8 个字符，避免弱访问码被轻易猜中。');
  }

  return {
    host,
    port: Number(process.env.PORT ?? 4310),
    databasePath: process.env.DATABASE_PATH ?? './.local/archsync-state.json',
    githubToken:
      process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.length > 0
        ? process.env.GITHUB_TOKEN
        : null,
    authMode,
    authCode,
    authCodeMinLength: 8,
    presenceTtlSeconds: Number(process.env.PRESENCE_TTL_SECONDS ?? 45),
    watchDebounceMs: Number(process.env.WATCH_DEBOUNCE_MS ?? 500),
    nodeEnv: process.env.NODE_ENV ?? 'development',
  };
}

/** Opaque session token for the code mode cookie store. */
export function newSessionToken(): string {
  return randomBytes(24).toString('base64url');
}
