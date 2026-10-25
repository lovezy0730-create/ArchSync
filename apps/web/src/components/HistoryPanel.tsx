import { useEffect, useMemo, useState } from 'react';
import { diffSnapshots, type SnapshotDiff } from '@archsync/graph';
import type { Snapshot } from '@archsync/contracts';
import { useStore } from '../store.js';

interface HistoryVersionMeta {
  version: number;
  contentHash: string;
  generatedAt: string;
  sourceCommitSha: string;
  file: string;
}

interface HistoryIndex {
  projectId: string;
  versions: HistoryVersionMeta[];
}

function timeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Snapshot history & diff viewer. Static mode loads versioned snapshots from
 * data/history/<id>/; the server mode currently shows only the live snapshot
 * (server-side history lands with the SQLite store).
 */
export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const snapshot = useStore((s) => s.snapshot);
  const mode = useStore((s) => s.mode);
  const [history, setHistory] = useState<HistoryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [baseSnapshot, setBaseSnapshot] = useState<Snapshot | null>(null);
  const [loadingBase, setLoadingBase] = useState(false);

  useEffect(() => {
    if (mode !== 'static' || !snapshot) return;
    const base = import.meta.env.BASE_URL ?? '/';
    const url = (rel: string) => `${base}${rel}`.replace(/\/{2,}/g, '/');
    fetch(url(`data/history/${snapshot.projectId}/index.json`))
      .then((res) => {
        if (!res.ok) throw new Error(`历史索引不可用 (HTTP ${res.status})`);
        return res.json();
      })
      .then((idx: HistoryIndex) => setHistory(idx))
      .catch((err) => setError((err as Error).message));
  }, [mode, snapshot]);

  const diff: SnapshotDiff | null = useMemo(() => {
    if (!snapshot || !baseSnapshot) return null;
    return diffSnapshots(baseSnapshot, snapshot);
  }, [baseSnapshot, snapshot]);

  const loadVersion = async (version: number): Promise<void> => {
    if (!snapshot || !history) return;
    const meta = history.versions.find((v) => v.version === version);
    if (!meta) return;
    setLoadingBase(true);
    setError(null);
    try {
      const base = import.meta.env.BASE_URL ?? '/';
      const url = `${base}data/history/${snapshot.projectId}/${meta.file}`.replace(/\/{2,}/g, '/');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`加载 v${version} 失败 (HTTP ${res.status})`);
      const payload = (await res.json()) as { snapshot: Snapshot };
      setBaseSnapshot(payload.snapshot);
      setBaseVersion(version);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingBase(false);
    }
  };

  return (
    <div className="history-overlay" role="dialog" aria-label="快照历史">
      <div className="history-card">
        <div className="history-head">
          <h3>快照历史与差异</h3>
          <button className="close-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>

        {mode !== 'static' && (
          <p className="history-hint">
            本地完整模式的历史版本库随 SQLite 存储在后续版本提供；当前显示实时快照。
          </p>
        )}
        {error && <div className="conflict-note">⚠ {error}</div>}

        {history && (
          <div className="history-list">
            <span className="history-col-head">选择对比基线（当前为最新）：</span>
            {history.versions.map((v) => (
              <button
                key={v.version}
                className={`history-item ${baseVersion === v.version ? 'active' : ''} ${v.version === snapshot?.version ? 'current' : ''}`}
                onClick={() => void loadVersion(v.version)}
                title={`v${v.version} · ${v.sourceCommitSha.slice(0, 8)} · hash ${v.contentHash.slice(0, 8)}`}
              >
                <span className="hv">v{v.version}</span>
                <span className="ht">{timeShort(v.generatedAt)}</span>
                <span className="hs">{v.sourceCommitSha.slice(0, 8)}</span>
                {v.version === snapshot?.version && <span className="tag ws">当前</span>}
              </button>
            ))}
          </div>
        )}
        {!history && mode === 'static' && !error && <p className="history-hint">加载历史索引…</p>}

        {loadingBase && <p className="history-hint">加载基线快照…</p>}

        {diff && (
          <div className="history-diff">
            <div className="diff-title">
              v{diff.from.version} <span className="arrow">→</span> v{diff.to.version}
              <span className="muted">（{diff.modules.length + diff.stateChanges.length + diff.edges.length} 处变化）</span>
            </div>
            {diff.modules.length + diff.stateChanges.length + diff.edges.length === 0 && (
              <p className="muted">两个版本内容一致（无实质变化）。</p>
            )}
            {diff.modules.length > 0 && (
              <section>
                <h5>模块增删</h5>
                <ul>
                  {diff.modules.map((m) => (
                    <li key={m.id} className={m.change === 'added' ? 'added' : 'removed'}>
                      {m.change === 'added' ? '＋' : '－'} {m.label} <code>{m.id}</code>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {diff.stateChanges.length > 0 && (
              <section>
                <h5>状态变化</h5>
                <ul>
                  {diff.stateChanges.map((c, i) => (
                    <li key={i}>
                      {c.label} · {c.field === 'implementation' ? '实现' : '任务'}：
                      <code>{c.from}</code> → <code>{c.to}</code>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {diff.edges.length > 0 && (
              <section>
                <h5>依赖变化</h5>
                <ul>
                  {diff.edges.map((e) => (
                    <li key={e.id + e.change} className={e.change === 'added' ? 'added' : 'removed'}>
                      {e.change === 'added' ? '＋' : '－'} {e.source} → {e.target}
                      <span className="tag">{e.kind}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
        {!diff && !loadingBase && history && history.versions.length > 1 && (
          <p className="history-hint">点击任意历史版本作为基线，与当前快照对比。</p>
        )}
        {history && history.versions.length <= 1 && !error && (
          <p className="history-hint">目前只有一个已存档版本；代码或协作数据变化后 CI 会产生新版本。</p>
        )}
      </div>
    </div>
  );
}
