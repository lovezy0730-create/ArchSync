import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sha256.js';

describe('sha256Hex (pure JS, browser-safe)', () => {
  it('matches FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('handles multi-block inputs and non-ASCII', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
    // node:crypto cross-check vector computed offline for '中文'
    expect(sha256Hex('中文')).toBe(
      '72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21',
    );
  });
});
