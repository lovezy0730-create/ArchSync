import { useState } from 'react';
import { parseProjectConfig } from '@archsync/config';
import { useStore } from '../store.js';

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
  const registryAddLocal = useStore((st) => st.registryAddLocal);
  const registryAnalyzeGithub = useStore((st) => st.registryAnalyzeGithub);
  const preview = useStore(st => st.registryInitPreview);
  const apply = useStore(st => st.registryInitApply);
  const clone = useStore(st => st.registryClone);
  const [yaml, setYaml] = useState<string | null>(null);
  const [cloneMode,setCloneMode] = useState(false);
  const [tab, setTab] = useState<'local' | 'github'>('local');
  const [localPath, setLocalPath] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hint = yaml === null ? null : '架构建议基于文件目录，尚未确认。请检查路径和模块后保存。';

  const addLocal = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = yaml === null ? await registryAddLocal(localPath.trim()) : await apply(localPath.trim(),yaml);
      if (!result.project) throw new Error('添加成功但未返回项目');
      onAdded(result.project.id);
      onClose();
    } catch (err) {
      const e = err as Error & { payload?: { needsInit?: boolean; initSuggestion?: { sampleDirs: string[] } } };
      if (e.payload?.needsInit) {
        try {const candidate = await preview(localPath.trim()); setYaml(candidate.yaml); setError(null);}
        catch (failure) {setError((failure as Error).message);}
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

    try {
      const cleaned = githubUrl.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/,'');
      if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) throw new Error('请输入有效的公开 GitHub 仓库地址');
      const [owner, repo] = cleaned.split('/');
      if (!owner || !repo) throw new Error('格式应为 owner/repo 或 GitHub 仓库 URL');
      if (cloneMode) {
        const parent = localPath.trim();
        if (!parent) throw new Error('请先选择克隆保存目录');
        const cloned = await clone(owner,repo,parent);
        setLocalPath(cloned.path); setTab('local');
        try {
          const added = await registryAddLocal(cloned.path);
          if (added.project) { onAdded(added.project.id); onClose(); }
        } catch (err) {
          const e = err as Error & {payload?:{needsInit?:boolean}};
          if (!e.payload?.needsInit) throw err;
          setYaml((await preview(cloned.path)).yaml);
        }
      } else {
        const result = await registryAnalyzeGithub(owner, repo);
        if (!result.project) throw new Error('未返回已注册项目');
        onAdded(result.project.id); onClose();
      }
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
                onChange={(e) => {setLocalPath(e.target.value);setYaml(null);}}
                placeholder="例如 D:\\code\\my-project"
                maxLength={1024}
              />
              <button type="button" className="primary" disabled={busy || localPath.trim().length === 0 || (yaml !== null && !parseProjectConfig(yaml).ok)} onClick={() => void addLocal()}>
                {busy ? '验证中…' : yaml === null ? '添加' : '确认保存并监控'}
              </button>
            </div>
            {window.archsyncDesktop && <button disabled={busy} onClick={() => { void window.archsyncDesktop?.chooseFolder().then(p => {if(p) {setLocalPath(p);setYaml(null);}}); }}>浏览文件夹</button>}
            {yaml !== null && <><label htmlFor="candidate-yaml">候选架构 YAML</label><textarea id="candidate-yaml" rows={14} value={yaml} onChange={e => setYaml(e.target.value)} style={{width:'100%',fontFamily:'monospace'}} />
              {!parseProjectConfig(yaml).ok && <p role="alert">{parseProjectConfig(yaml).errors.map(e => e.message).join('；')}</p>}</>}
          </>
        ) : (
          <>
            <p className="login-hint">
              输入公开 GitHub 仓库持续监控 PR、Issue 和 CI。远端只读模式没有本地文件扫描，架构保持未知。
            </p>
            <label><input type="checkbox" checked={cloneMode} onChange={e => setCloneMode(e.target.checked)} />克隆到本地并监控（需要 Git）</label>
            {cloneMode && <div><input aria-label="克隆保存目录" value={localPath} onChange={e => setLocalPath(e.target.value)} placeholder="克隆保存目录" />{window.archsyncDesktop && <button onClick={() => {void window.archsyncDesktop?.chooseFolder().then(p => {if(p) setLocalPath(p);});}}>浏览文件夹</button>}</div>}
            <div className="dialog-form-row">
              <input
                autoFocus
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                placeholder="https://github.com/owner/repo 或 owner/repo"
                maxLength={300}
              />
              <button type="button" className="primary" disabled={busy || githubUrl.trim().length === 0} onClick={() => void analyzeGithub()}>
                {busy ? '接入中…' : cloneMode ? '克隆并接入' : '添加远端监控'}
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
