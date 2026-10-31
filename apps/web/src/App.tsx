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

  return (
    <div className="app">
      <TopBar onAddProject={() => setAddOpen(true)} showCode={codeMode} />
      <div className="app-body">
        {!codeMode && <Sidebar />}
        <main className="canvas-area">
          {mode === 'server' && <button className="workspace-toggle" onClick={() => setShowCode(!showCode)}>{showCode ? '规划视图' : '代码架构'}</button>}
          {codeMode && projectId ? <CodeWorkbench projectId={projectId} /> : !codeMode && <ReactFlowProvider>
            <GraphCanvas />
          </ReactFlowProvider>}
          {codeMode && booted && !projectId && <div className="welcome-panel"><h2>欢迎使用 ArchSync</h2>{loadError && <p role="alert">{loadError}</p>}<p>打开本地仓库，发现真实代码架构。扫描在本机完成。</p><button onClick={() => setAddOpen(true)}>打开或克隆仓库</button><p>也可以添加 GitHub 远端只读监控。</p></div>}
          {!codeMode && loadError && (
            <div className="canvas-error">
              <strong>数据加载失败</strong>
              <span>{loadError}</span>
              <span className="hint">静态模式：请确认站点由 pnpm build:pages 构建且包含 data/ 目录。</span>
            </div>
          )}
          {!codeMode && booted && !loadError && !snapshot && (
            <div className="canvas-empty">
              {identity || useStore.getState().mode === 'static' ? '正在加载快照…' : '等待身份确认…'}
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
