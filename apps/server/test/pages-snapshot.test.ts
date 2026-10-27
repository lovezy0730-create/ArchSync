import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoSecrets, publishStaticSnapshots } from '../src/pages/generate-static-snapshot.js';

const NOW = '2026-10-25T00:00:00.000Z';

describe('publishStaticSnapshots (against the real repo)', () => {
  let outDir: string;
  let historyDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'archsync-pages-out-'));
    historyDir = await mkdtemp(join(tmpdir(), 'archsync-pages-hist-'));
  });
  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(historyDir, { recursive: true, force: true });
  });

  it('publishes publishStatic projects; sticky demo data + archsync live (offline)', async () => {
    const result = await publishStaticSnapshots({ outDir, historyDir, now: NOW, offline: true, log: () => {} });
    const ids = result.published.map((p) => p.id);
    expect(ids).toContain('sticky-notes');
    // the self-describing project now opts in to publishing (repo is public)
    expect(ids).toContain('archsync');

    const snapshotText = await readFile(join(outDir, 'snapshot-sticky-notes.json'), 'utf8');
    const payload = JSON.parse(snapshotText) as {
      snapshot: {
        githubSource: string;
        githubDemo: boolean;
        projectId: string;
        defaultViewId?: string;
        views?: Array<{ id: string; groups: unknown[] }>;
      };
    };
    expect(payload.snapshot.githubSource).toBe('demo');
    expect(payload.snapshot.githubDemo).toBe(true);
    expect(payload.snapshot.defaultViewId).toBe('product-systems');
    expect(payload.snapshot.views?.map((view) => view.id)).toEqual(['product-systems', 'user-journey']);
    expect(payload.snapshot.views?.[0]?.groups.length).toBe(4);

    const manifest = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8')) as {
      projects: Array<{ id: string }>;
      generator: string;
    };
    expect(manifest.generator).toBe('archsync-static-snapshot');
    expect(manifest.projects.map((p) => p.id)).toEqual(ids);
  });

  it('is reproducible and version-stable for identical inputs', async () => {
    const outDir2 = await mkdtemp(join(tmpdir(), 'archsync-pages-out2-'));
    try {
      const first = await publishStaticSnapshots({ outDir, historyDir, now: NOW, offline: true, log: () => {} });
      const second = await publishStaticSnapshots({ outDir: outDir2, historyDir, now: NOW, offline: true, log: () => {} });
      expect(first.published.map((p) => p.contentHash)).toEqual(
        second.published.map((p) => p.contentHash),
      );
      // identical content must not bump versions (T17)
      expect(second.published.every((p) => p.versionBumped === false)).toBe(true);
      expect(second.published.map((p) => p.version)).toEqual(first.published.map((p) => p.version));
    } finally {
      await rm(outDir2, { recursive: true, force: true });
    }
  });

  it('publishes the self project with real repo paths (public dogfood) + history index', async () => {
    const files = await readFile(join(outDir, 'index.json'), 'utf8');
    const manifest = JSON.parse(files) as {
      projects: Array<{ id: string; historyIndex: string; githubSource: string }>;
    };
    const self = manifest.projects.find((p) => p.id === 'archsync');
    expect(self).toBeTruthy();
    // offline mode: live fetch skipped, collab degrades to unavailable honestly
    expect(self?.githubSource).toBe('unavailable');
    expect(self?.historyIndex).toBe('data/history/archsync/index.json');
    // history index written for the project
    const historyIndex = JSON.parse(
      await readFile(join(outDir, 'history', 'archsync', 'index.json'), 'utf8'),
    ) as { versions: Array<{ version: number }> };
    expect(historyIndex.versions.length).toBe(1);
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
