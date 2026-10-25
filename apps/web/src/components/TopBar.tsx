import { useMemo } from 'react';
import { useStore } from '../store.js';
import {
  IMPLEMENTATION_META,
  WORKFLOW_META,
  githubSourceLabel,
  timeAgo,
} from './statusMeta.js';
import type { ImplementationState, WorkflowState } from '@archsync/contracts';

export function TopBar() {
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const snapshot = useStore((s) => s.snapshot);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const switchProject = useStore((s) => s.switchProject);
  const filters = useStore((s) => s.filters);
  const toggleWorkflowFilter = useStore((s) => s.toggleWorkflowFilter);
  const toggleImplementationFilter = useStore((s) => s.toggleImplementationFilter);
  const clearFilters = useStore((s) => s.clearFilters);
  const participants = useStore((s) => s.participants);
  const me = useStore((s) => s.me);
  const identity = useStore((s) => s.identity);
  const wsStatus = useStore((s) => s.wsStatus);
  const syncing = useStore((s) => s.syncing);
  const resync = useStore((s) => s.resync);

  const gh = githubSourceLabel(snapshot?.githubSource ?? 'unavailable', snapshot?.githubDemo ?? false);
  const filterCount = filters.workflow.size + filters.implementation.size + filters.layers.size;

  const online = useMemo(() => [...participants.values()], [participants]);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">A</span>
        <span className="brand-name">ArchSync</span>
        <span className="brand-sub">架构协作工作台</span>
      </div>

      <select
        className="project-select"
        value={projectId ?? ''}
        onChange={(e) => void switchProject(e.target.value)}
        aria-label="切换项目"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}{p.demoCollab ? '（示例）' : ''}
          </option>
        ))}
      </select>

      {snapshot?.githubDemo && <span className="badge badge-demo" title="该项目的 Issue/PR/成员数据来自演示数据 fixture">DEMO 数据</span>}
      <span className={`badge badge-gh badge-${snapshot?.githubSource ?? 'unavailable'}`} title={snapshot?.githubDemo ? '协作数据为演示 fixture' : 'GitHub 协作数据来源'}>
        ● {gh.label}
      </span>

      <div className="searchbox">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索模块 / 负责人…"
          aria-label="搜索模块"
        />
        {search && (
          <button className="clear-btn" onClick={() => setSearch('')} aria-label="清空搜索">×</button>
        )}
      </div>

      <div className="filter-chips">
        {(Object.keys(WORKFLOW_META) as WorkflowState[]).map((state) => (
          <button
            key={state}
            className={`fchip ${filters.workflow.has(state) ? 'on' : ''}`}
            style={{ ['--c' as string]: WORKFLOW_META[state].color }}
            onClick={() => toggleWorkflowFilter(state)}
            title={`筛选任务状态：${WORKFLOW_META[state].label}`}
          >
            {WORKFLOW_META[state].label}
          </button>
        ))}
        <span className="fchip-sep" />
        {(Object.keys(IMPLEMENTATION_META) as ImplementationState[]).map((state) => (
          <button
            key={state}
            className={`fchip ${filters.implementation.has(state) ? 'on' : ''}`}
            style={{ ['--c' as string]: IMPLEMENTATION_META[state].color }}
            onClick={() => toggleImplementationFilter(state)}
            title={`筛选实现状态：${IMPLEMENTATION_META[state].label}`}
          >
            {IMPLEMENTATION_META[state].label}
          </button>
        ))}
        {filterCount > 0 && (
          <button className="fchip clear" onClick={clearFilters}>
            清除筛选 ({filterCount})
          </button>
        )}
      </div>

      <div className="topbar-right">
        <div className="sync-info" title={`快照 v${snapshot?.version ?? 0} · 生成于 ${snapshot?.generatedAt ?? '-'}\n作用域：本地工作区 @ ${snapshot?.branch ?? '-'} (${(snapshot?.sourceCommitSha ?? '').slice(0, 8)})`}>
          <span className="sync-version">v{snapshot?.version ?? '–'}</span>
          <span className="sync-time">{timeAgo(snapshot?.generatedAt ?? null)}</span>
        </div>
        <button className="resync-btn" onClick={() => void resync()} disabled={syncing} title="重新扫描工作区并刷新快照">
          {syncing ? '同步中…' : '⟳ 重新扫描'}
        </button>

        <div className="presence-cluster" title="当前在线成员">
          {me && (
            <span className="avatar me" style={{ background: me.color ?? '#58a6ff' }} title={`我：${me.name}`}>
              {me.name.slice(0, 1)}
            </span>
          )}
          {online.slice(0, 5).map((p) => (
            <span key={p.sessionId} className="avatar" style={{ background: p.color }} title={`${p.name}${p.editingField ? ' · 正在编辑备注' : p.selectedModuleId ? ` · 正在查看 ${p.selectedModuleId}` : ''}`}>
              {p.name.slice(0, 1)}
            </span>
          ))}
          {online.length > 5 && <span className="avatar more">+{online.length - 5}</span>}
        </div>
        <div className={`conn-dot conn-${wsStatus}`} title={`实时连接：${wsStatus === 'open' ? '已连接' : wsStatus === 'connecting' ? '连接中' : '已断开（自动重连）'}`} />
        {identity && <span className="me-name">{identity.name}</span>}
      </div>
    </header>
  );
}
