import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../src/auth-rate-limit.js';

describe('LoginRateLimiter', () => {
  it('blocks after 10 failures and unblocks after the window', () => {
    const limiter = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) limiter.recordFailure('ip-a', t0);
    expect(limiter.isBlocked('ip-a', t0)).toBe(false);
    limiter.recordFailure('ip-a', t0); // 10th failure → blocked
    expect(limiter.isBlocked('ip-a', t0 + 1)).toBe(true);
    expect(limiter.isBlocked('ip-a', t0 + 15 * 60_000)).toBe(false);
  });

  it('success clears the counter; other IPs are unaffected', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 9; i++) limiter.recordFailure('ip-a');
    limiter.recordFailure('ip-a');
    limiter.recordSuccess('ip-a');
    expect(limiter.isBlocked('ip-a')).toBe(false);
    for (let i = 0; i < 10; i++) limiter.recordFailure('ip-b');
    expect(limiter.isBlocked('ip-b')).toBe(true);
  });

  it('separate windows reset the count', () => {
    const limiter = new LoginRateLimiter();
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) limiter.recordFailure('ip-c', t0);
    // after the 15-min window the counter restarts
    limiter.recordFailure('ip-c', t0 + 16 * 60_000);
    expect(limiter.isBlocked('ip-c', t0 + 16 * 60_000 + 1)).toBe(false);
  });
});
