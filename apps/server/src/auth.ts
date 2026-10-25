import { timingSafeEqual, createHash } from 'node:crypto';
import { newSessionToken } from './env.js';

export const SESSION_COOKIE = 'archsync_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h; re-login after that

interface Session {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * In-memory session store for the access-code auth mode. Sessions are opaque
 * random tokens; only their SHA-256 is kept, so a memory dump never reveals
 * usable cookie values. Single instance only (same as presence state).
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  issue(): string {
    const token = newSessionToken();
    const now = Date.now();
    this.sessions.set(this.key(token), {
      tokenHash: this.hash(token),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return token;
  }

  validate(token: string | undefined): boolean {
    if (!token || token.length < 20 || token.length > 128) return false;
    const session = this.sessions.get(this.key(token));
    if (!session) return false;
    if (session.tokenHash !== this.hash(token) || Date.now() > session.expiresAt) {
      this.sessions.delete(this.key(token));
      return false;
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(this.key(token));
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(key);
    }
  }

  private key(token: string): string {
    // Map token to a stable bucket key without storing the raw value.
    return this.hash(token).slice(0, 16);
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(createHash('sha256').update(a).digest());
  const bb = Buffer.from(createHash('sha256').update(b).digest());
  return timingSafeEqual(ab, bb);
}

/** Parse a Cookie header into a flat record (no external dependency). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function sessionTokenFromRequest(request: { headers: Record<string, unknown> }): string | undefined {
  const cookieHeader = request.headers.cookie;
  const cookies = parseCookies(typeof cookieHeader === 'string' ? cookieHeader : undefined);
  return cookies[SESSION_COOKIE];
}

export function buildSessionCookie(token: string, secure: boolean): string {
  const flags = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${flags}`;
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
