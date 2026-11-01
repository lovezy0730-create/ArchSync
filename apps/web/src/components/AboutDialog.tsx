import { useEffect, useState } from 'react';
import { api, type DiagnosticsInfo } from '../lib/api.js';

/**
 * About / diagnostics: version and build identity must be visible to the user,
 * and the report must be copyable without DevTools.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.diagnostics()
      .then((value) => { if (alive) setInfo(value); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : '诊断信息不可用'); });
    return () => { alive = false; };
  }, []);

  const lastError = (() => {
    try { return window.localStorage.getItem('archsync-last-error'); } catch { return null; }
  })();
  const report = info
    ? JSON.stringify({ ...info, lastRendererError: lastError ? JSON.parse(lastError) : null }, null, 2)
    : `diagnostics unavailable: ${error}\nlastRendererError: ${lastError ?? 'none'}`;

  return (
    <div className="history-overlay" role="dialog" aria-label="关于与诊断">
      <div className="history-card about-card">
        <div className="history-head">
          <h3>关于 / 诊断</h3>
          <button className="close-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {error && <p className="code-alert" role="alert">{error}</p>}
        {info ? (
          <>
            <dl className="about-grid">
              <dt>应用版本</dt><dd>{info.app.version}</dd>
              <dt>Build SHA</dt><dd>{info.app.sha}{info.app.dirty ? '（含未提交修改）' : ''}</dd>
              <dt>构建时间</dt><dd>{info.app.builtAt ?? '未知'}</dd>
              <dt>Agent</dt><dd>Node {info.agent.node} · pid {info.agent.pid} · {info.agent.phase}</dd>
              <dt>数据库 schema</dt><dd>{info.database.schemaVersion ?? '未知'}</dd>
              <dt>数据目录</dt><dd className="about-path">{info.dataDir}</dd>
              <dt>日志目录</dt><dd className="about-path">{info.logDir ?? '未知'}</dd>
              <dt>启动</dt><dd>{info.startup.listenMs === null ? '尚未完成' : `HTTP 监听 ${info.startup.listenMs}ms`} · 已恢复 {info.startup.restoredProjects} 个项目 · 后台扫描 {info.startup.background.completed}/{info.startup.background.total}{info.startup.background.failed ? `（失败 ${info.startup.background.failed}）` : ''}</dd>
              <dt>已注册项目</dt><dd>{info.projects.length}</dd>
            </dl>
            <div className="about-projects">
              {info.projects.map((project) => (
                <p key={project.id}>
                  <strong>{project.name}</strong>
                  <span className="hint"> · {project.kind ?? 'local'} · 快照 v{project.snapshotVersion ?? '—'} · 索引 {project.codeIndex ? `${project.codeIndex.files} 文件 / ${project.codeIndex.symbols} 符号` : '未扫描'}{project.codeState?.error ? ` · ${project.codeState.error}` : ''}</span>
                </p>
              ))}
            </div>
          </>
        ) : !error ? <p className="hint">正在读取诊断信息…</p> : null}
        <div className="about-actions">
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(report).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }).catch(() => undefined);
            }}
          >
            {copied ? '已复制' : '复制脱敏诊断报告'}
          </button>
          <button onClick={() => window.location.reload()}>重新加载界面</button>
        </div>
        <p className="hint">报告只包含版本、路径、计数和错误摘要，不包含源码内容或令牌。</p>
      </div>
    </div>
  );
}
