import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export interface GitInfo {
  available: boolean;
  branch: string | null;
  head: string | null;
  dirty: number | null;
  error: string | null;
}

/**
 * Local Git facts read directly from the repository, independent of any
 * snapshot or GitHub sync. A failed scan must not hide the current HEAD, and a
 * missing snapshot must not block this probe.
 */
export async function readGitInfo(rootDir: string): Promise<GitInfo> {
  if (!rootDir) return { available: false, branch: null, head: null, dirty: null, error: '远端只读项目没有本地工作区' };
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: rootDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  };
  try {
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    let branch: string | null = null;
    try {
      branch = (await git(['branch', '--show-current'])).trim() || null;
    } catch {
      branch = null;
    }
    let dirty: number | null = null;
    try {
      const status = await git(['status', '--porcelain']);
      dirty = status.split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      dirty = null;
    }
    return { available: true, branch, head, dirty, error: null };
  } catch (error) {
    return {
      available: false,
      branch: null,
      head: null,
      dirty: null,
      error: `Git 状态不可用: ${(error as Error).message}`,
    };
  }
}
