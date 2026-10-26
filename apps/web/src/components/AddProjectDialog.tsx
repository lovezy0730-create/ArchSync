import { useState } from 'react';
import { registryApi } from '../lib/registry-api.js';

interface Props {
  onClose: () => void;
  onAdded: (projectId: string) => void;
}

/**
 * 添加项目对话框（v1.1 阶段 A/E）：
 * - 本地 Git 仓库（绝对路径，验证 + 注册 + 自动首扫）
 * - GitHub 仓库 URL（只读远端分析：诚实说明需克隆后添加才能监控本地）
 */
export function AddProjectDialog({ onClose, onAdded }: Props) {
  const [tab, setTab] = useState<'local' | 'github'>('local');
  const [localPath, setLocalPath] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const addLocal = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await registryApi.addLocal(localPath.trim());
      onAdded(result.project.id);
      onClose();
    } catch (err) {
      const e = err as Error & { payload?: { needsInit?: boolean; initSuggestion?: { sampleDirs: string[] } } };
      if (e.payload?.needsInit) {
        const dirs = (e.payload.initSuggestion?.sampleDirs ?? []).join('、');
        setError(`该项目还没有 .archsync/project.yaml。建议的模块目录：${dirs || '（未检测到）'}。先运行 pnpm archsync:init -- <owner/repo> 生成后再添加。`);
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const analyzeGithub = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const cleaned = githubUrl.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      const [owner, repo] = cleaned.split('/');
      if (!owner || !repo) throw new Error('格式应为 owner/repo 或 GitHub 仓库 URL');
      const result = await registryApi.analyzeGithub(owner, repo);
      setHint(
        `${owner}/${repo}（默认分支 ${String(result.facts?.defaultBranch)}，${String(result.facts?.language)}，${result.facts?.isPrivate ? '私有' : '公开'}）——${String(result.facts?.note)}`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-project-overlay" role="dialog" aria-label="添加项目">
      <div className="add-project-card">
        <div className="history-head">
          <h3>添加项目</h3>
          <button className="close-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="tab-row">
          <button className={tab === 'local' ? 'tab on' : 'tab'} onClick={() => setTab('local')}>本地 Git 仓库</button>
          <button className={tab === 'github' ? 'tab on' : 'tab'} onClick={() => setTab('github')}>GitHub 仓库</button>
        </div>

        {tab === 'local' ? (
          <>
            <p className="login-hint">
              输入本机 Git 仓库的绝对路径（支持 worktree）。ArchSync 会读取分支/远端信息、
              注册并自动扫描架构；已有的 .archsync/project.yaml 将被直接采用。
            </p>
            <div className="dialog-form-row">
              <input
                autoFocus
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="例如 D:\\code\\my-project"
                maxLength={1024}
              />
              <button type="button" className="primary" disabled={busy || localPath.trim().length === 0} onClick={() => void addLocal()}>
                {busy ? '验证中…' : '添加'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="login-hint">
              输入公开 GitHub 仓库进行<strong>只读远端分析</strong>（默认分支/语言/元数据）。
              远端分析无法观察未推送的本地修改；要持续监控请先克隆到本地，再用「本地 Git 仓库」添加。
            </p>
            <div className="dialog-form-row">
              <input
                autoFocus
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                placeholder="https://github.com/owner/repo 或 owner/repo"
                maxLength={300}
              />
              <button type="button" className="primary" disabled={busy || githubUrl.trim().length === 0} onClick={() => void analyzeGithub()}>
                {busy ? '分析中…' : '分析'}
              </button>
            </div>
          </>
        )}

        {hint && <div className="import-toast ok" style={{ position: 'static', transform: 'none', marginTop: 12 }}>{hint}</div>}
        {error && <div className="conflict-note">⚠ {error}</div>}
      </div>
    </div>
  );
}
