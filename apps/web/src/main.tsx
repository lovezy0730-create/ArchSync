import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

// Global diagnostics: async/event-handler errors are not caught by React
// boundaries. Keep them in a bounded in-memory list so the About/diagnostics
// panel and the Windows E2E can see them, and never let them blank the app.
interface RendererErrorRecord { at: string; source: string; message: string; stack?: string }
const errors: RendererErrorRecord[] = [];
const record = (source: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? '' : '';
  errors.push({ at: new Date().toISOString(), source, message, stack });
  if (errors.length > 50) errors.shift();
  try {
    (window as unknown as { __archsyncErrors?: RendererErrorRecord[] }).__archsyncErrors = errors;
    window.localStorage.setItem('archsync-last-error', JSON.stringify(errors[errors.length - 1]).slice(0, 8000));
  } catch { /* storage unavailable */ }
  console.error(`[archsync:${source}]`, error);
};
window.addEventListener('error', (event) => record('window.error', event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => record('unhandledrejection', event.reason));

try {
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary scope="ArchSync">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  (window as unknown as { __archsyncReady?: boolean }).__archsyncReady = true;
} catch (error) {
  record('bootstrap', error);
  rootEl.innerHTML = '';
  const fallback = document.createElement('div');
  fallback.className = 'fatal-error';
  fallback.setAttribute('role', 'alert');
  fallback.innerHTML = `<div class="fatal-error-card"><strong>ArchSync 界面启动失败</strong><p>请重新加载；若持续失败请查看用户数据目录 logs/main.log。</p><pre>${String((error as Error)?.message ?? error).slice(0, 800)}</pre><div class="fatal-error-actions"><button onclick="location.reload()">重新加载</button></div></div>`;
  rootEl.appendChild(fallback);
}
