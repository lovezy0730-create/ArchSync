import type { GithubState } from '../lib/data-provider.js';
import { useEffect, useMemo, useState } from 'react';
import type { TimelineEvent } from '../lib/data-provider-registry.js';
import { useStore } from '../store.js';

/** 项目动态时间线（v1.1）：GitHub 事件 + 本地变化 + 同步日志。 */
export function TimelinePanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const githubState = useStore(st => st.registryGithubState);
  const [github,setGithub] = useState<GithubState|null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const loadTimeline = useStore((st) => st.loadTimeline);
  useEffect(() => {
    let active=true;
    setGithub(null);setEvents([]);setError(null);
    void githubState(projectId).then(r=>{if(active) setGithub(r);}).catch(err=>{if(active) setError(err.message);});
    void loadTimeline(projectId, 200)
      .then((r) => {if(active) setEvents(r.events as unknown as TimelineEvent[]);})
      .catch((err) => {if(active) setError((err as Error).message);});
    return ()=>{active=false;};
  }, [projectId, loadTimeline, githubState]);

  // Opening this panel during the first GitHub sync used to freeze it on the
  // pre-sync "unavailable" placeholder. Re-read the registry state while it is
  // still not live, so real PR/Issue data appears as soon as the pass lands.
  useEffect(() => {
    if (github?.collab.source === 'live') return;
    let active = true;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (!active || attempts > 10) { clearInterval(timer); return; }
      void githubState(projectId)
        .then((next) => { if (active) setGithub(next); })
        .catch(() => undefined);
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [github?.collab.source, projectId, githubState]);

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
        {github && <section aria-label="GitHub 当前状态">
          <p className="history-hint">来源 {github.collab.source} · 同步时间 {github.collab.fetchedAt ?? '尚未同步'} · 远端 HEAD {github.head?.sha ?? '未知'} · CI {github.ci?.state ?? 'unknown'}</p>
          {github.collab.error && <p role="alert">{github.collab.error} · 保留上次数据，请刷新 GitHub 重试</p>}
          <details open><summary>PR（{github.collab.pullRequests.length}）</summary><ul>{github.collab.pullRequests.map(p=><li key={p.number}><a target="_blank" rel="noreferrer" href={`https://github.com/${github.repository.split('/').map(encodeURIComponent).join('/')}/pull/${p.number}`}>#{p.number} {p.title}</a> · {p.mergedAt?'merged':p.state} · {p.author} · {p.assignees.join(', ') || '未指派'} · CI {p.checks} · {p.headSha?.slice(0,8) ?? 'SHA 未知'} · {p.changedFilesKnown ? `${p.changedFiles.length} 个变更文件` : '变更文件尚未同步'}</li>)}</ul></details>
          <details><summary>Issue（{github.collab.issues.length}）</summary><ul>{github.collab.issues.map(i=><li key={i.number}><a target="_blank" rel="noreferrer" href={`https://github.com/${github.repository.split('/').map(encodeURIComponent).join('/')}/issues/${i.number}`}>#{i.number} {i.title}</a> · {i.state} · {i.assignees.join(', ') || '未指派'} · {i.labels.join(', ')}</li>)}</ul></details>
        </section>}
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

