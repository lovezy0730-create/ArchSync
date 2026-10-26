import { useEffect, useMemo, useState } from 'react';
import type { TimelineEvent } from '../lib/data-provider-registry.js';
import { useStore } from '../store.js';

/** 项目动态时间线（v1.1）：GitHub 事件 + 本地变化 + 同步日志。 */
export function TimelinePanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const loadTimeline = useStore((st) => st.loadTimeline);
  useEffect(() => {
    void loadTimeline(projectId, 200)
      .then((r) => setEvents(r.events as unknown as TimelineEvent[]))
      .catch((err) => setError((err as Error).message));
  }, [projectId, loadTimeline]);

  const filtered = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.eventType.startsWith(filter))),
    [events, filter],
  );

  const EVENT_ICON: Record<string, string> = {
    pr_opened: '⑂',
    pr_updated: '⑂',
    pr_merged: '⑂',
    pr_modules_mapped: '⇢',
    issue_opened: '☺',
    issue_closed: '☺',
    issue_reopened: '☺',
    issue_updated: '☺',
    commit_pushed: '⎇',
    ci_status: '⚙',
  };

  return (
    <div className="history-overlay" role="dialog" aria-label="项目动态">
      <div className="history-card timeline-card">
        <div className="history-head">
          <h3>项目动态</h3>
          <button className="close-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {error && <div className="conflict-note">⚠ {error}</div>}
        <div className="fchip-row">
          {['all', 'pr', 'issue', 'commit', 'ci'].map((f) => (
            <button key={f} className={`fchip ${filter === f ? 'on' : ''}`} style={{ ['--c' as string]: '#58a6ff' }} onClick={() => setFilter(f)}>
              {f === 'all' ? '全部' : f.toUpperCase()}
            </button>
          ))}
        </div>
        {events.length === 0 && !error && <p className="history-hint">暂无动态；本地文件变化或 GitHub 轮询发现事件后会出现在这里。</p>}
        <ul className="timeline-list">
          {filtered.map((e) => (
            <li key={e.id} className="timeline-item">
              <span className="tl-icon" title={e.eventType}>{EVENT_ICON[e.eventType] ?? '•'}</span>
              <span className="tl-body">
                <span className="tl-title">{e.title}</span>
                <span className="tl-meta">
                  {e.source} · {e.eventType} · {new Date(e.occurredAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

