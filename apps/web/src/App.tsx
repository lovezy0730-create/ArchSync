import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useStore } from './store.js';
import { TopBar } from './components/TopBar.js';
import { Sidebar } from './components/Sidebar.js';
import { GraphCanvas } from './components/GraphCanvas.js';
import { DetailsDrawer } from './components/DetailsDrawer.js';
import { LoginDialog } from './components/LoginDialog.js';
import { CodeWorkbench } from './components/CodeWorkbench.js';
import { AddProjectDialog } from './components/AddProjectDialog.js';

export function App() {
  const boot = useStore((s) => s.boot);
  const booted = useStore((s) => s.booted);
  const snapshot = useStore((s) => s.snapshot);
  const snapshotStatus = useStore((s) => s.snapshotStatus);
  const snapshotError = useStore((s) => s.snapshotError);
  const snapshotJobId = useStore((s) => s.snapshotJobId);
  const ensureSnapshot = useStore((s) => s.ensureSnapshot);
  const retrySnapshot = useStore((s) => s.retrySnapshot);
  const identity = useStore((s) => s.identity);
  const loadError = useStore((s) => s.loadError);
  const projectId = useStore((s) => s.projectId);
  const mode = useStore((s) => s.mode);
  const switchProject = useStore((s) => s.switchProject);
  const loadRegistry = useStore((s) => s.loadRegistry);
  const setIdentity = useStore((s) => s.setIdentity);
  const authMode = useStore((s) => s.authMode);
  const [showCode, setShowCode] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const codeMode = mode === 'server' && showCode;

  useEffect(() => {
    void boot();
  }, [boot]);
  useEffect(() => {
    if (booted && window.archsyncDesktop && !identity && authMode !== 'code') setIdentity({ name: '本地用户' });
  }, [booted, identity, authMode, setIdentity]);

  // Switching to the architecture view must actively guarantee its data.
  // The old behaviour only swapped components and could sit on a placeholder
  // forever if the first snapshot load had failed or was still building.
  useEffect(() => {
    if (!codeMode && booted && projectId) void ensureSnapshot();
  }, [codeMode, booted, projectId, ensureSnapshot]);

  const showGraph = !codeMode;
  const graphPending = showGraph && projectId !== null && snapshotStatus === 'pending';
  const graphLoading = showGraph && projectId !== null && (snapshotStatus === 'loading' || snapshotStatus === 'idle') && !snapshot;
  const graphError = showGraph && projectId !== null && snapshotStatus === 'error';

  return (
    <div className="app">
      <TopBar onAddProject={() => setAddOpen(true)} showCode={codeMode} />
      <div className="app-body">
        {!codeMode && <Sidebar />}
        <main className="canvas-area">
          {mode === 'server' && (
            <button className="workspace-toggle" onClick={() => setShowCode(!showCode)}>
              {showCode ? '规划视图' : '代码架构'}
            </button>
          )}
          {codeMode && projectId ? <CodeWorkbench projectId={projectId} /> : !codeMode && <ReactFlowProvider>
            <GraphCanvas />
          </ReactFlowProvider>}
          {codeMode && booted && !projectId && (
            <div className="welcome-panel">
              <h2>欢迎使用 ArchSync</h2>
              {loadError && <p role="alert">{loadError}</p>}
              <p>打开本地仓库，发现真实代码架构。扫描在本机完成。</p>
              <button onClick={() => setAddOpen(true)}>打开或克隆仓库</button>
              <p>也可以添加 GitHub 远端只读监控。</p>
            </div>
          )}
          {!codeMode && loadError && (
            <div className="canvas-error">
              <strong>数据加载失败</strong>
              <span>{loadError}</span>
              <span className="hint">静态模式：请确认站点由 pnpm build:pages 构建且包含 data/ 目录。</span>
            </div>
          )}
          {!codeMode && !loadError && projectId && snapshotStatus === 'stale' && snapshot && (
            <div className="canvas-stale" role="status">
              <span>正在显示上次成功加载的架构快照，可能已过期。</span>
              {snapshotError && <span className="hint">{snapshotError}</span>}
              <button onClick={() => void retrySnapshot()}>重试刷新</button>
            </div>
          )}
          {!codeMode && !loadError && graphPending && (
            <div className="canvas-pending" role="status">
              <strong>架构快照正在生成</strong>
              <span>首次扫描较大仓库可能需要更长时间；本地代码索引不受影响。</span>
              {snapshotJobId && <span className="hint">任务 {snapshotJobId.slice(0, 8)}</span>}
              <button onClick={() => void retrySnapshot()}>立即重试</button>
            </div>
          )}
          {!codeMode && !loadError && graphError && (
            <div className="canvas-error" role="alert">
              <strong>架构快照加载失败</strong>
              <span>{snapshotError ?? '未知原因'}</span>
              <button onClick={() => void retrySnapshot()}>重试</button>
              <span className="hint">本地代码扫描与架构快照相互独立；可先切回“代码架构”查看真实符号。</span>
            </div>
          )}
          {!codeMode && !loadError && graphLoading && (
            <div className="canvas-empty">
              {identity || mode === 'static' ? '正在加载架构快照…' : '等待身份确认…'}
            </div>
          )}
        </main>
        {!codeMode && <DetailsDrawer />}
      </div>
      <LoginDialog />
      {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} onAdded={(id) => { void loadRegistry(); void switchProject(id); }} />}
    </div>
  );
}
