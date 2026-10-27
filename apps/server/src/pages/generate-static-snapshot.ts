/**
 * Build-time static snapshot generator (GitHub Pages data pipeline).
 *
 * Output contract (written to the bundle data dir):
 *   data/index.json                      → manifest (projects, versions, history)
 *   data/snapshot-<id>.json              → current Snapshot per published project
 *   data/history/<id>/index.json         → version index for the history view
 *   data/history/<id>/v<N>.json          → full archived snapshot per version
 *
 * History persistence: versioned snapshots live in a *tracked* history dir
 * (default `site-snapshots/` committed to the dedicated `site-snapshots`
 * branch by CI). Local runs seed an empty history. Identical content hashes
 * never create a new version (T17 semantics across builds).
 *
 * Safety gates (unchanged from v0.1, now with live data):
 * - publishStatic gate per project; publishPublicGithubData enables anonymous
 *   public API fetching (tokens are refused by design).
 * - secret scan before every write; SnapshotSchema validation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile, readdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollabData, ModuleDetail, Snapshot } from '@archsync/contracts';
import { SnapshotSchema, CollabDataSchema } from '@archsync/contracts';
import { buildSnapshot } from '@archsync/graph';
import { scanProject } from '@archsync/scanner';
import { discoverProjects, type ProjectEntry } from '../projects.js';
import { readDemoCollab } from './demo-collab.js';
import { fetchPublicCollab, type RecentCommit } from './public-github.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const outDir = join(repoRoot, 'apps', 'web', 'public', 'data');
const historyDir = join(repoRoot, 'site-snapshots');
const MAX_HISTORY_VERSIONS = 20;

export interface PublishOptions {
  outDir?: string;
  historyDir?: string;
  now?: string;
  log?: (...args: unknown[]) => void;
  /** skip network: unit tests and offline local runs */
  offline?: boolean;
}

export interface HistoryVersionMeta {
  version: number;
  contentHash: string;
  generatedAt: string;
  sourceCommitSha: string;
  file: string;
}

export interface ProjectHistoryIndex {
  projectId: string;
  versions: HistoryVersionMeta[];
}

export interface PublishResult {
  published: Array<{
    id: string;
    name: string;
    file: string;
    version: number;
    contentHash: string;
    versionBumped: boolean;
  }>;
  skipped: string[];
  manifest: Manifest;
  recentCommits: Record<string, RecentCommit[]>;
}

export interface Manifest {
  generator: 'archsync-static-snapshot';
  generatorVersion: '0.2.0';
  generatedAt: string;
  sourceCommitSha: string | null;
  projects: Array<{
    id: string;
    name: string;
    file: string;
    version: number;
    generatedAt: string;
    contentHash: string;
    sourceCommitSha: string;
    githubSource: string;
    historyIndex: string;
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

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['github-pat', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['github-pat-v2', /github_pat_[A-Za-z0-9_]{20,}/],
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

async function readHistoryIndex(dir: string, projectId: string): Promise<ProjectHistoryIndex> {
  const indexFile = join(dir, projectId, 'index.json');
  if (!existsSync(indexFile)) return { projectId, versions: [] };
  try {
    return JSON.parse(readFileSync(indexFile, 'utf8')) as ProjectHistoryIndex;
  } catch {
    return { projectId, versions: [] };
  }
}

async function writeHistoryVersion(
  dir: string,
  projectId: string,
  snapshot: Snapshot,
): Promise<{ version: number; versionBumped: boolean; file: string }> {
  const index = await readHistoryIndex(dir, projectId);
  const latest = index.versions[0];
  if (latest && latest.contentHash === snapshot.contentHash) {
    // identical content: keep version number (T17: no meaningless versions)
    return { version: latest.version, versionBumped: false, file: latest.file };
  }
  const version = (latest?.version ?? 0) + 1;
  const file = `v${version}.json`;
  const payloadText = JSON.stringify(
    {
      kind: 'archsync-static-snapshot',
      snapshotVersion: version,
      snapshot: { ...snapshot, version },
    },
    null,
    2,
  );
  assertNoSecrets(payloadText, `history/${projectId}/${file}`);
  await mkdir(join(dir, projectId), { recursive: true });
  await writeFile(join(dir, projectId, file), payloadText, 'utf8');
  const versions: HistoryVersionMeta[] = [
    {
      version,
      contentHash: snapshot.contentHash,
      generatedAt: snapshot.generatedAt,
      sourceCommitSha: snapshot.sourceCommitSha,
      file,
    },
    ...index.versions,
  ].slice(0, MAX_HISTORY_VERSIONS);
  await writeFile(
    join(dir, projectId, 'index.json'),
    JSON.stringify({ projectId, versions } satisfies ProjectHistoryIndex, null, 2),
    'utf8',
  );
  return { version, versionBumped: true, file };
}

export async function publishStaticSnapshots(options: PublishOptions = {}): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const now = resolveNow(options);
  const targetDir = options.outDir ?? outDir;
  const targetHistory = options.historyDir ?? historyDir;
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
  await mkdir(join(targetDir, 'history'), { recursive: true });

  const published: PublishResult['published'] = [];
  const manifestProjects: Manifest['projects'] = [];
  const recentCommits: Record<string, RecentCommit[]> = {};

  for (const entry of publishable) {
    const { snapshot, commits } = await buildProjectSnapshot(entry, now, options, log);
    recentCommits[entry.id] = commits;

    const history = await writeHistoryVersion(targetHistory, entry.id, snapshot);
    const finalSnapshot: Snapshot = { ...snapshot, version: history.version };

    const details: Record<string, ModuleDetail> = {};
    for (const m of finalSnapshot.modules) {
      details[m.id] = { ...m, annotation: { text: '', revision: 1, updatedBy: null, updatedAt: null } };
    }

    const file = `snapshot-${finalSnapshot.projectId}.json`;
    const payload = {
      kind: 'archsync-static-snapshot',
      snapshotVersion: finalSnapshot.version,
      snapshot: finalSnapshot,
      moduleDetails: details,
      recentCommits: commits,
    };
    const text = JSON.stringify(payload, null, 2);
    assertNoSecrets(text, file);
    SnapshotSchema.parse(finalSnapshot);
    await writeFile(join(targetDir, file), text, 'utf8');

    // copy the full history (index + version files) into the bundle
    const projectHistoryDir = join(targetHistory, entry.id);
    if (existsSync(projectHistoryDir)) {
      const bundleHistoryDir = join(targetDir, 'history', entry.id);
      await mkdir(bundleHistoryDir, { recursive: true });
      for (const name of await readdir(projectHistoryDir)) {
        await copyFile(join(projectHistoryDir, name), join(bundleHistoryDir, name));
      }
    }

    published.push({
      id: finalSnapshot.projectId,
      name: finalSnapshot.projectName,
      file,
      version: history.version,
      contentHash: finalSnapshot.contentHash,
      versionBumped: history.versionBumped,
    });
    manifestProjects.push({
      id: finalSnapshot.projectId,
      name: finalSnapshot.projectName,
      file,
      version: history.version,
      generatedAt: finalSnapshot.generatedAt,
      contentHash: finalSnapshot.contentHash,
      sourceCommitSha: finalSnapshot.sourceCommitSha,
      githubSource: finalSnapshot.githubSource,
      historyIndex: `data/history/${entry.id}/index.json`,
    });
    log(
      `已生成 ${file} (v${history.version}${history.versionBumped ? ' 新版本' : ' 内容未变'}, hash ${finalSnapshot.contentHash}, deps=${finalSnapshot.dependencyAnalysis})`,
    );
  }

  const manifest: Manifest = {
    generator: 'archsync-static-snapshot',
    generatorVersion: '0.2.0',
    generatedAt: now,
    sourceCommitSha: headSha,
    projects: manifestProjects,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  assertNoSecrets(manifestText, 'index.json');
  await writeFile(join(targetDir, 'index.json'), manifestText, 'utf8');

  return { published, skipped: [...skipped, ...notMarked], manifest, recentCommits };
}

async function buildProjectSnapshot(
  entry: ProjectEntry,
  now: string,
  options: PublishOptions,
  log: (...args: unknown[]) => void,
): Promise<{ snapshot: Snapshot; commits: RecentCommit[] }> {
  // pin scan timestamps to the build clock so identical inputs → identical hash
  const scan = await scanProject(entry.config, entry.rootDir, () => now);
  let collab: CollabData;
  let commits: RecentCommit[] = [];

  if (options.offline !== true && entry.config.project.publishPublicGithubData === true) {
    const { owner, repo } = entry.config.project.github;
    const result = await fetchPublicCollab(owner, repo, { log });
    collab = result.collab;
    commits = result.commits;
    log(
      `${entry.id}: 匿名公开 GitHub 数据（issues=${collab.issues.length}, prs=${collab.pullRequests.length}, 预算剩余 ${result.budget.remaining}/${result.budget.maxRequests}${result.budget.rateLimited ? '，已限流降级' : ''}）`,
    );
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

  const snapshot = buildSnapshot({
    config: entry.config,
    configWarnings: entry.configWarnings,
    viewWarnings: entry.viewWarnings,
    views: entry.views,
    defaultViewId: entry.defaultViewId,
    configBlobSha: entry.configBlobSha,
    scan,
    collab,
    version: 1, // real version assigned by the history writer
    snapshotId: `static-${entry.id}`,
    now,
  });
  return { snapshot, commits };
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
