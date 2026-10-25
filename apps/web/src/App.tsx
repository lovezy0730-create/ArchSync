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
          {booted && !snapshot && (
            <div className="canvas-empty">
              {identity ? '正在加载快照…' : '等待身份确认…'}
            </div>
          )}
        </main>
        <DetailsDrawer />
      </div>
      <LoginDialog />
    </div>
  );
}
