import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoSecrets, publishStaticSnapshots } from '../src/pages/generate-static-snapshot.js';

const NOW = '2026-10-25T00:00:00.000Z';

describe('publishStaticSnapshots (against the real repo)', () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'archsync-pages-out-'));
  });
  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('publishes only the publishStatic=true project with demo data', async () => {
    const result = await publishStaticSnapshots({ outDir, now: NOW, log: () => {} });
    const ids = result.published.map((p) => p.id);
    expect(ids).toContain('sticky-notes');
    expect(ids).not.toContain('archsync');

    const snapshotText = await readFile(join(outDir, 'snapshot-sticky-notes.json'), 'utf8');
    const payload = JSON.parse(snapshotText) as {
      snapshot: { githubSource: string; githubDemo: boolean; projectId: string };
    };
    expect(payload.snapshot.githubSource).toBe('demo');
    expect(payload.snapshot.githubDemo).toBe(true);

    const manifest = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8')) as {
      projects: Array<{ id: string }>;
      generator: string;
    };
    expect(manifest.generator).toBe('archsync-static-snapshot');
    expect(manifest.projects.map((p) => p.id)).toEqual(ids);
  });

  it('is reproducible: identical inputs produce identical content hashes', async () => {
    const outDir2 = await mkdtemp(join(tmpdir(), 'archsync-pages-out2-'));
    try {
      const first = await publishStaticSnapshots({ outDir, now: NOW, log: () => {} });
      const second = await publishStaticSnapshots({ outDir: outDir2, now: NOW, log: () => {} });
      expect(first.published.map((p) => p.contentHash)).toEqual(
        second.published.map((p) => p.contentHash),
      );
    } finally {
      await rm(outDir2, { recursive: true, force: true });
    }
  });

  it('private project paths never appear in the published bundle', async () => {
    const files = await readFile(join(outDir, 'index.json'), 'utf8');
    const manifest = JSON.parse(files) as { projects: Array<{ id: string }> };
    expect(manifest.projects.map((p) => p.id)).not.toContain('archsync');
    // the self-describing project maps real repo paths like packages/graph —
    // none of the repo's own module globs may leak
    expect(files).not.toContain('packages/graph');
  });

  it('demo fixture data passes the secret scan', async () => {
    const snapshotText = await readFile(join(outDir, 'snapshot-sticky-notes.json'), 'utf8');
    expect(() => assertNoSecrets(snapshotText, 'snapshot-sticky-notes.json')).not.toThrow();
  });
});

describe('assertNoSecrets', () => {
  it('rejects token-shaped strings and private keys', () => {
    expect(() => assertNoSecrets('token ghp_1234567890abcdefghijklmn', 'x')).toThrow(/github-pat/);
    expect(() => assertNoSecrets('AUTH_CODE=hunter2hunter2', 'x')).toThrow(/access-code-env/);
    expect(() => assertNoSecrets('-----BEGIN RSA PRIVATE KEY-----', 'x')).toThrow(/private-key/);
    expect(() => assertNoSecrets('clean data with 模块 names', 'x')).not.toThrow();
  });
});
