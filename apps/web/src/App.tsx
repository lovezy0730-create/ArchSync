import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useStore } from './store.js';
import { TopBar } from './components/TopBar.js';
import { Sidebar } from './components/Sidebar.js';
import { GraphCanvas } from './components/GraphCanvas.js';
import { DetailsDrawer } from './components/DetailsDrawer.js';
import { LoginDialog } from './components/LoginDialog.js';

export function App() {
  const boot = useStore((s) => s.boot);
  const booted = useStore((s) => s.booted);
  const snapshot = useStore((s) => s.snapshot);
  const identity = useStore((s) => s.identity);
  const loadError = useStore((s) => s.loadError);

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <main className="canvas-area">
          <ReactFlowProvider>
            <GraphCanvas />
          </ReactFlowProvider>
          {loadError && (
            <div className="canvas-error">
              <strong>数据加载失败</strong>
              <span>{loadError}</span>
              <span className="hint">静态模式：请确认站点由 pnpm build:pages 构建且包含 data/ 目录。</span>
            </div>
          )}
          {booted && !loadError && !snapshot && (
            <div className="canvas-empty">
              {identity || useStore.getState().mode === 'static' ? '正在加载快照…' : '等待身份确认…'}
            </div>
          )}
        </main>
        <DetailsDrawer />
      </div>
      <LoginDialog />
    </div>
  );
}
