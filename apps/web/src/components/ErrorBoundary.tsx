import { Component, type ReactNode } from 'react';
import { useStore } from '../store.js';

interface Props {
  children: ReactNode;
  /** Scope label shown in the fallback, e.g. "代码工作台". */
  scope?: string;
  /** Optional local reset; the global actions (reload / reset selection) always exist. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * Keeps a render failure inside one panel instead of blanking the window.
 * The fallback offers a real recovery path: reload, or clear the persisted
 * workbench selection (never the database) and reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    this.setState({ info: info.componentStack ?? '' });
    const record = { at: new Date().toISOString(), scope: this.props.scope ?? 'app', message: error.message, stack: error.stack ?? '', componentStack: info.componentStack ?? '' };
    try {
      const target = window as unknown as { __archsyncErrors?: unknown[] };
      target.__archsyncErrors = [...(target.__archsyncErrors ?? []), record];
      // Keep the last error available to the About/diagnostics panel.
      window.localStorage.setItem('archsync-last-error', JSON.stringify(record).slice(0, 8000));
    } catch { /* storage unavailable */ }
    console.error('[archsync] render error', record);
  }

  private resetSelection = async (): Promise<void> => {
    const projectId = useStore.getState().projectId;
    try {
      window.localStorage.removeItem('archsync-code-view');
      window.localStorage.removeItem('archsync-code-file-view');
      window.localStorage.removeItem('archsync-project');
    } catch { /* storage unavailable */ }
    if (projectId) {
      try {
        await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/workspace`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ moduleId: null, filePath: null, symbolUid: null }),
        });
      } catch { /* the reload below still recovers to the project list */ }
    }
    this.props.onReset?.();
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const detail = `${this.state.error.message}\n${this.state.error.stack ?? ''}\n${this.state.info}`.trim();
    return (
      <div className="fatal-error" role="alert">
        <div className="fatal-error-card">
          <strong>{this.props.scope ?? '界面'}渲染失败</strong>
          <p>数据库和项目注册没有被修改。可以先重载，或清除当前视图选择后重载。</p>
          <pre>{detail.slice(0, 1600)}</pre>
          <div className="fatal-error-actions">
            <button onClick={() => window.location.reload()}>重新加载</button>
            <button onClick={() => void this.resetSelection()}>清除视图选择并重载</button>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(detail).catch(() => undefined);
              }}
            >
              复制错误详情
            </button>
          </div>
          <span className="hint">错误也会写入浏览器本地记录；主进程日志在用户数据目录 logs/main.log。</span>
        </div>
      </div>
    );
  }
}
