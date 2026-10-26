import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.js';
import {
  IMPLEMENTATION_META,
  WORKFLOW_META,
  githubSourceLabel,
  timeAgo,
} from './statusMeta.js';
import type { ImplementationState, WorkflowState } from '@archsync/contracts';
import type { YamlImportResult } from '../store.js';
import { HistoryPanel } from './HistoryPanel.js';
import { AddProjectDialog } from './AddProjectDialog.js';
import { TimelinePanel } from './TimelinePanel.js';
import { registryApi, type RegistryProjectInfo } from '../lib/registry-api.js';

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
  const mode = useStore((s) => s.mode);
  const capabilities = useStore((s) => s.capabilities);
  const importYaml = useStore((s) => s.importYaml);
  const booted = useStore((s) => s.booted);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [registry, setRegistry] = useState<RegistryProjectInfo[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importMessage, setImportMessage] = useState<YamlImportResult | null>(null);

  const gh = githubSourceLabel(snapshot?.githubSource ?? 'unavailable', snapshot?.githubDemo ?? false);
  const filterCount = filters.workflow.size + filters.implementation.size + filters.layers.size;
  const isStatic = mode === 'static';

  const online = useMemo(() => [...participants.values()], [participants]);

  // registry drives the project switcher in server mode (dynamic multi-repo)
  useEffect(() => {
    if (mode !== 'server' || !booted) return;
    void registryApi.list().then((r) => setRegistry(r.projects)).catch(() => undefined);
  }, [mode, booted, projectId]);

  const projectOptions = useMemo(() => {
    if (mode === 'server' && registry.length > 0) {
      return registry.map((r) => ({ id: r.id, label: `${r.name}${r.repo ? `（${r.owner}/${r.repo}）` : ''}` }));
    }
    return projects.map((p) => ({ id: p.id, label: `${p.name}${p.demoCollab ? '（示例）' : ''}` }));
  }, [mode, registry, projects]);

  const handleYamlFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const result = await importYaml(text);
    setImportMessage(result);
    setTimeout(() => setImportMessage(null), result.ok ? 6000 : 12000);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">A</span>
        <span className="brand-name">ArchSync</span>
        <span className={`badge badge-mode badge-mode-${mode}`}>
          {isStatic ? '静态快照' : '本地服务'}
        </span>
      </div>

      <div className="project-switcher">
        <select
          className="project-select"
          value={projectId ?? ''}
          onChange={(e) => void switchProject(e.target.value)}
          aria-label="切换项目"
        >
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {mode === 'server' && (
          <button
            className="import-btn add-project-btn"
            title="添加项目（本地 Git 仓库或 GitHub 只读分析）"
            onClick={() => setAddOpen(true)}
          >
            ＋
          </button>
        )}
        {mode === 'server' && projectId && (
          <button
            className="import-btn"
            title="项目动态（GitHub 事件 / 本地变化时间线）"
            onClick={() => setTimelineOpen(true)}
          >
            ≡ 动态
          </button>
        )}
      </div>

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
        <div className="sync-info" title={isStatic
          ? `静态快照 v${snapshot?.version ?? 0} · 构建于 ${snapshot?.generatedAt ?? '-'}\nCommit: ${(snapshot?.sourceCommitSha ?? '').slice(0, 8)}\n构建时数据，非实时`
          : `快照 v${snapshot?.version ?? 0} · 生成于 ${snapshot?.generatedAt ?? '-'}\n作用域：本地工作区 @ ${snapshot?.branch ?? '-'} (${(snapshot?.sourceCommitSha ?? '').slice(0, 8)})`}>
          <span className="sync-version">v{snapshot?.version ?? '–'}</span>
          <span className="sync-time">{isStatic ? '构建于 ' : ''}{timeAgo(snapshot?.generatedAt ?? null)}</span>
        </div>

        {capabilities.resync ? (
          <button className="resync-btn" onClick={() => void resync()} disabled={syncing} title="重新扫描工作区并刷新快照">
            {syncing ? '同步中…' : '⟳ 重新扫描'}
          </button>
        ) : (
          <span className="static-hint" title="静态模式下重新扫描不可用：数据由构建时生成">构建时数据</span>
        )}

        {isStatic && (
          <button
            className="import-btn"
            onClick={() => setHistoryOpen(true)}
            title="查看快照历史与架构差异"
          >
            ⏱ 历史 / 差异
          </button>
        )}
        {isStatic && historyOpen && (
          <HistoryPanel onClose={() => setHistoryOpen(false)} />
        )}
        {capabilities.yamlImport && (
          <>
            <button className="import-btn" onClick={() => fileInputRef.current?.click()} title="导入本地 .archsync/project.yaml 预览（文件不会上传）">
              ⇪ 导入 YAML
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml,text/yaml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleYamlFile(file);
              }}
            />
          </>
        )}

        {capabilities.identity ? (
          <>
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
          </>
        ) : (
          <span className="static-hint" title="静态模式不提供实时协作（光标/在线状态）——使用 pnpm dev 可体验完整模式">无实时协作</span>
        )}
      </div>

      {addOpen && (
        <AddProjectDialog
          onClose={() => setAddOpen(false)}
          onAdded={(newId) => {
            void registryApi.list().then((r) => setRegistry(r.projects)).catch(() => undefined);
            void switchProject(newId);
          }}
        />
      )}
      {timelineOpen && projectId && <TimelinePanel projectId={projectId} onClose={() => setTimelineOpen(false)} />}
      {importMessage && (
        <div className={`import-toast ${importMessage.ok ? 'ok' : 'err'}`}>
          {importMessage.ok
            ? `已导入 ${importMessage.projectId}，已切换到导入预览${(importMessage.warnings?.length ?? 0) > 0 ? `（${importMessage.warnings!.length} 条警告）` : ''}`
            : (importMessage.message ?? `配置无效: ${importMessage.errors?.[0]?.message ?? ''}`)}
          <button onClick={() => setImportMessage(null)}>×</button>
        </div>
      )}
    </header>
  );
}
