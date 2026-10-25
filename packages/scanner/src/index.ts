/**
 * Local workspace scanner.
 *
 * Truthfulness contract (FR-04/05/07):
 * - "baseline" = files committed at git HEAD. "workspace" = files on disk.
 * - The overlay (uncommitted added/modified/deleted) is always reported
 *   separately and never mixed into the mainline picture.
 * - When git or the filesystem walk fails, the scan reports failure and
 *   downstream code must render `unknown`, never "not detected".
 * - No repository code is ever executed; only an allowlist of git
 *   subcommands is spawned and no shell interpolation happens.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import type {
  ModuleScanResult,
  ProjectConfigFile,
  ScanOverlayChange,
  ScanResult,
} from '@archsync/contracts';

const execFileAsync = promisify(execFile);

const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.local',
  'coverage',
  '.archsync-cache',
]);

const IGNORED_FILE_PATTERN = /^(\.env|\.DS_Store|Thumbs\.db)/;

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isIgnoredPath(posixPath: string): boolean {
  const segments = posixPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (IGNORED_DIR_NAMES.has(seg)) return true;
  }
  const file = segments[segments.length - 1] ?? '';
  return IGNORED_FILE_PATTERN.test(file);
}

/* ------------------------------------------------------------------ */
/* Pure glob matching                                                 */
/* ------------------------------------------------------------------ */

export function matchPaths(globs: string[], files: string[]): string[] {
  if (globs.length === 0) return [];
  const matchers = globs.map((g) => picomatch(g, { dot: false }));
  return files
    .filter((f) => isIgnoredPath(f) === false)
    .filter((f) => matchers.some((m) => m(f)))
    .sort();
}

export function computeModuleScans(
  config: ProjectConfigFile,
  baselineFiles: string[],
  workspaceFiles: string[],
  overlay: ScanOverlayChange[],
): ModuleScanResult[] {
  const results: ModuleScanResult[] = config.modules.map((m) => {
    const matchedBaselinePaths = matchPaths(m.paths, baselineFiles);
    const matchedWorkspacePaths = matchPaths(m.paths, workspaceFiles);
    const overlayChanges = overlay.filter((c) => matchPaths(m.paths, [c.path]).length > 0);
    return {
      moduleId: m.id,
      matchedBaselinePaths,
      matchedWorkspacePaths,
      overlayChanges,
      overlappedWith: [],
    };
  });

  // Detect cross-module glob overlaps on the same workspace file.
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i]!;
      const b = results[j]!;
      const shared = a.matchedWorkspacePaths.filter((p) => b.matchedWorkspacePaths.includes(p));
      if (shared.length > 0) {
        a.overlappedWith.push(b.moduleId);
        b.overlappedWith.push(a.moduleId);
      }
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Filesystem walk                                                    */
/* ------------------------------------------------------------------ */

export async function listWorkspaceFiles(
  rootDir: string,
): Promise<{ files: string[]; rootError: string | null }> {
  const files: string[] = [];
  let rootError: string | null = null;
  const walk = async (dir: string, isRoot: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) rootError = `无法读取项目根目录: ${(err as Error).message}`;
      return; // unreadable subdir: skip rather than fail the whole walk
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.archsync') && entry.isDirectory()) continue;
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      const rel = toPosix(join(dir, entry.name).slice(rootDir.length + 1));
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), false);
      } else if (entry.isFile()) {
        if (!isIgnoredPath(rel)) files.push(rel);
      }
      // Symlinks are deliberately not followed (path-escape safety).
    }
  };
  await walk(rootDir, true);
  return { files: files.sort(), rootError };
}

/* ------------------------------------------------------------------ */
/* Git helpers (strict allowlist, no shell)                           */
/* ------------------------------------------------------------------ */

const GIT_TIMEOUT_MS = 15_000;

async function git(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: rootDir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export interface GitBaseline {
  sha: string;
  branch: string | null;
  files: string[];
}

export async function readGitBaseline(rootDir: string): Promise<GitBaseline> {
  const sha = (await git(rootDir, ['rev-parse', 'HEAD'])).trim();
  let branch: string | null = null;
  try {
    branch = (await git(rootDir, ['branch', '--show-current'])).trim() || null;
  } catch {
    branch = null; // detached HEAD or unborn branch
  }
  const tree = await git(rootDir, ['ls-tree', '-r', '--name-only', 'HEAD']);
  const files = tree
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isIgnoredPath(toPosix(l)))
    .map(toPosix)
    .sort();
  return { sha, branch, files };
}

export function parseGitStatusPorcelain(zOutput: string): ScanOverlayChange[] {
  const changes: ScanOverlayChange[] = [];
  const records = zOutput.split('\0').filter((r) => r.length > 0);
  let i = 0;
  while (i < records.length) {
    const record = records[i]!;
    if (record.length < 4) {
      i++;
      continue;
    }
    const xy = record.slice(0, 2);
    const pathRaw = record.slice(3);
    const path = toPosix(pathRaw);
    // Rename/copy records carry the original path in the next NUL field.
    let origPath: string | null = null;
    if (xy[0] === 'R' || xy[0] === 'C') {
      const next = records[i + 1];
      if (next !== undefined && !/^[MARDU?]{1,2} /.test(next)) {
        origPath = toPosix(next);
        i++;
      }
    }
    if (!isIgnoredPath(path) && (origPath === null || !isIgnoredPath(origPath))) {
      const workCode = xy[1];
      const indexCode = xy[0];
      if (xy === '??') {
        changes.push({ path, kind: 'added', untracked: true });
      } else if (workCode === 'D' || indexCode === 'D') {
        changes.push({ path, kind: 'deleted', untracked: false });
      } else if (origPath !== null) {
        changes.push({ path: origPath, kind: 'deleted', untracked: false });
        changes.push({ path, kind: 'added', untracked: false });
      } else {
        changes.push({ path, kind: 'modified', untracked: false });
      }
    }
    i++;
  }
  return changes;
}

export async function readGitOverlay(rootDir: string): Promise<ScanOverlayChange[]> {
  const out = await git(rootDir, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return parseGitStatusPorcelain(out);
}

/* ------------------------------------------------------------------ */
/* Project scan                                                       */
/* ------------------------------------------------------------------ */

export async function scanProject(
  config: ProjectConfigFile,
  rootDir: string,
  now = (): string => new Date().toISOString(),
): Promise<ScanResult> {
  const errors: string[] = [];
  let baseline: GitBaseline | null = null;
  let overlay: ScanOverlayChange[] = [];
  let overlayOk = true;
  let walkOk = true;

  try {
    baseline = await readGitBaseline(rootDir);
  } catch (err) {
    errors.push(`git baseline 失败: ${(err as Error).message}`);
  }
  try {
    overlay = await readGitOverlay(rootDir);
  } catch (err) {
    overlayOk = false;
    errors.push(`git status 失败: ${(err as Error).message}`);
  }

  let workspaceFiles: string[] = [];
  try {
    const walk = await listWorkspaceFiles(rootDir);
    workspaceFiles = walk.files;
    if (walk.rootError !== null) {
      walkOk = false;
      errors.push(walk.rootError);
    }
  } catch (err) {
    walkOk = false;
    errors.push(`工作区扫描失败: ${(err as Error).message}`);
  }

  const baselineFiles = baseline?.files ?? [];
  const modules = computeModuleScans(config, baselineFiles, workspaceFiles, overlay);

  return {
    ok: baseline !== null && walkOk,
    baselineSha: baseline?.sha ?? null,
    branch: baseline?.branch ?? null,
    baselineFiles,
    workspaceFiles,
    overlay,
    modules,
    errors: [...errors, ...(overlayOk ? [] : ['overlay 不可用，本地未提交变化显示为未知'])],
    scannedAt: now(),
  };
}
