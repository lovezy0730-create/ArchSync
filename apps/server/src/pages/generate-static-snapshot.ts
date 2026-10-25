/**
 * Build-time static snapshot generator (GitHub Pages data pipeline).
 *
 * Output contract:
 * - apps/web/public/data/index.json         → manifest (projects, versions, hashes)
 * - apps/web/public/data/snapshot-<id>.json → full Snapshot for each published project
 *
 * Safety gates:
 * - Only projects whose project.yaml sets `project.publishStatic: true` are
 *   published. Everything else is skipped with a logged reason.
 * - Collaboration data comes from clearly-labelled demo fixtures by default.
 *   Live GitHub data is fetched ONLY when (a) the project config sets
 *   `publishPublicGithubData: true`, (b) anonymous public API access succeeds.
 *   No token is ever accepted here: a token would be a sign that private
 *   data is about to be published, which this tool refuses by design.
 * - The generated JSON is schema-validated and scanned for accidental secrets.
 *
 * Reproducibility: content hashes ignore volatile timestamps (see graph
 * package). Set SOURCE_DATE_EPOCH=<unix seconds> to pin generatedAt too.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollabData, ModuleDetail, Snapshot } from '@archsync/contracts';
import { SnapshotSchema, CollabDataSchema } from '@archsync/contracts';
import { buildSnapshot } from '@archsync/graph';
import { scanProject } from '@archsync/scanner';
import { discoverProjects, type ProjectEntry } from '../projects.js';
import { readDemoCollab } from './demo-collab.js';
import { fetchPublicCollab } from './public-github.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const outDir = join(repoRoot, 'apps', 'web', 'public', 'data');

export interface PublishOptions {
  /** override output dir (tests) */
  outDir?: string;
  now?: string;
  log?: (...args: unknown[]) => void;
}

export interface PublishResult {
  published: Array<{ id: string; name: string; file: string; version: number; contentHash: string }>;
  skipped: string[];
  manifest: Manifest;
}

export interface Manifest {
  generator: 'archsync-static-snapshot';
  generatorVersion: '0.1.0';
  generatedAt: string;
  sourceCommitSha: string | null;
  /** 'demo' when every published project uses fixture data */
  dataModes: string[];
  projects: Array<{
    id: string;
    name: string;
    file: string;
    version: number;
    generatedAt: string;
    contentHash: string;
    sourceCommitSha: string;
    githubSource: string;
  }>;
}

function resolveNow(options: PublishOptions): string {
  if (options.now) return options.now;
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

async function repoHeadSha(): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Secret scan: refuse to write anything that smells like a credential. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['github-pat', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['access-code-env', /AUTH_CODE=/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function assertNoSecrets(text: string, label: string): void {
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${label} 包含疑似敏感内容 (${name})，已中止写出。`);
    }
  }
}

export async function publishStaticSnapshots(options: PublishOptions = {}): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const now = resolveNow(options);
  const targetDir = options.outDir ?? outDir;
  const headSha = await repoHeadSha();

  const { projects: all, skipped } = discoverProjects(repoRoot);
  const publishable = all.filter((p) => p.config.project.publishStatic === true);
  const notMarked = all
    .filter((p) => p.config.project.publishStatic !== true)
    .map((p) => `${p.name} (${p.id})：project.publishStatic 未开启，跳过（私有数据保护默认）`);

  if (publishable.length === 0) {
    log('警告：没有任何项目设置 publishStatic: true，将只输出空清单。');
  }

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  const dataModes = new Set<string>();
  const published: PublishResult['published'] = [];
  const manifestProjects: Manifest['projects'] = [];

  for (const entry of publishable) {
    const snapshot = await buildProjectSnapshot(entry, now, log);
    dataModes.add(snapshot.githubSource);

    // annotations are a server-side collaborative feature; the static bundle
    // ships empty annotation records with an explicit placeholder author
    const details: Record<string, ModuleDetail> = {};
    for (const m of snapshot.modules) {
      details[m.id] = {
        ...m,
        annotation: {
          text: '',
          revision: 1,
          updatedBy: null,
          updatedAt: null,
        },
      };
    }

    const file = `snapshot-${snapshot.projectId}.json`;
    const payload = {
      kind: 'archsync-static-snapshot',
      snapshotVersion: snapshot.version,
      snapshot: snapshot,
      moduleDetails: details,
    };
    const text = JSON.stringify(payload, null, 2);
    assertNoSecrets(text, file);
    SnapshotSchema.parse(snapshot); // schema gate before publishing
    await writeFile(join(targetDir, file), text, 'utf8');

    published.push({
      id: snapshot.projectId,
      name: snapshot.projectName,
      file,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
    });
    manifestProjects.push({
      id: snapshot.projectId,
      name: snapshot.projectName,
      file,
      version: snapshot.version,
      generatedAt: snapshot.generatedAt,
      contentHash: snapshot.contentHash,
      sourceCommitSha: snapshot.sourceCommitSha,
      githubSource: snapshot.githubSource,
    });
    log(`已生成 ${file} (v${snapshot.version}, hash ${snapshot.contentHash})`);
  }

  const manifest: Manifest = {
    generator: 'archsync-static-snapshot',
    generatorVersion: '0.1.0',
    generatedAt: now,
    sourceCommitSha: headSha,
    dataModes: [...dataModes],
    projects: manifestProjects,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  assertNoSecrets(manifestText, 'index.json');
  await writeFile(join(targetDir, 'index.json'), manifestText, 'utf8');

  return { published, skipped: [...skipped, ...notMarked], manifest };
}

async function buildProjectSnapshot(
  entry: ProjectEntry,
  now: string,
  log: (...args: unknown[]) => void,
): Promise<Snapshot> {
  // pin scan timestamps to the build clock so identical inputs → identical hash
  const scan = await scanProject(entry.config, entry.rootDir, () => now);
  let collab: CollabData;

  if (entry.config.project.publishPublicGithubData === true) {
    collab = await fetchPublicCollab(entry.config.project.github.owner, entry.config.project.github.repo);
    log(`${entry.id}: 使用匿名公开 GitHub 数据（publishPublicGithubData=true）`);
  } else if (entry.demoCollabPath) {
    collab = readDemoCollab(entry.demoCollabPath, entry.demoCollabFetchedAt);
  } else {
    collab = CollabDataSchema.parse({
      source: 'unavailable',
      demo: false,
      fetchedAt: now,
      error: '静态构建未包含协作数据（未提供演示 fixture 且未开启公开 GitHub 数据）',
    });
  }

  return buildSnapshot({
    config: entry.config,
    configWarnings: entry.configWarnings,
    configBlobSha: entry.configBlobSha,
    scan,
    collab,
    version: 1,
    snapshotId: `static-${entry.id}`,
    now,
  });
}

// CLI entry (pnpm snapshot:generate)
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('generate-static-snapshot.ts')) {
  publishStaticSnapshots({ log: (...a) => console.log('[snapshot]', ...a) })
    .then((result) => {
      for (const reason of result.skipped) console.log('[snapshot] 跳过:', reason);
      console.log(`[snapshot] 完成：${result.published.length} 个项目发布到 ${outDir}`);
    })
    .catch((err) => {
      console.error('[snapshot] 失败:', err.message);
      process.exit(1);
    });
}
