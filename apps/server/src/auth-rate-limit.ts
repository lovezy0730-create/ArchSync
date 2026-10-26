import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * In-memory brute-force protection for the login endpoint, keyed by client IP.
 *
 * Bounds (deliberately simple, single-instance scope):
 * - 10 failed attempts per IP per 15-minute window → HTTP 429
 * - Successful login clears the counter
 * - Entries are bounded (evict oldest beyond 5000 keys) so an attacker cannot
 *   inflate memory with spoofed IPs behind a trusted proxy
 *
 * Limitation (documented in docs/known-issues.md): per-IP rate limiting is
 * bypassable via spoofed IPs unless the reverse proxy normalizes X-Forwarded-For
 * — Fastify's default `ip` comes from the socket peer, which is trustworthy
 * for direct and proxied deployments without custom header trust.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_KEYS = 5000;

export class LoginRateLimiter {
  private failures = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();

  isBlocked(ip: string, now = Date.now()): boolean {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (entry.blockedUntil > now) return true;
    return false;
  }

  recordFailure(ip: string, now = Date.now()): void {
    if (this.failures.size >= MAX_KEYS && !this.failures.has(ip)) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    const entry = this.failures.get(ip);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      this.failures.set(ip, { count: 1, windowStart: now, blockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.blockedUntil = now + WINDOW_MS;
    }
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }

  /** test hook */
  reset(): void {
    this.failures.clear();
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(createHash('sha256').update(a).digest());
  const bb = Buffer.from(createHash('sha256').update(b).digest());
  return timingSafeEqual(ab, bb);
}
