import { useMemo, useState } from 'react';
import { useStore } from '../store.js';
import { WORKFLOW_META, IMPLEMENTATION_META } from './statusMeta.js';
import { matchesSearch } from '../lib/layout.js';
import { activeView, resolveViewGroups, snapshotViews } from '../lib/view-layout.js';

const VIEW_KIND_LABEL = { system: '系统', flow: '流程', layer: '分层' } as const;

export function Sidebar() {
  const snapshot = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const search = useStore((s) => s.search);
  const filters = useStore((s) => s.filters);
  const select = useStore((s) => s.select);
  const toggleViewGroupFilter = useStore((s) => s.toggleViewGroupFilter);
  const activeViewId = useStore((s) => s.activeViewId);
  const setActiveView = useStore((s) => s.setActiveView);
  const moveViewGroup = useStore((s) => s.moveViewGroup);
  const moveViewModule = useStore((s) => s.moveViewModule);
  const resetViewOrder = useStore((s) => s.resetViewOrder);
  const viewOrderOverrides = useStore((s) => s.viewOrderOverrides);
  const [editingOrder, setEditingOrder] = useState(false);

  const view = useMemo(
    () => (snapshot ? activeView(snapshot, activeViewId) : null),
    [snapshot, activeViewId],
  );
  const views = useMemo(() => (snapshot ? snapshotViews(snapshot) : []), [snapshot]);
  const override = view ? viewOrderOverrides[view.id] : undefined;
  const viewDiagnostics = snapshot?.viewDiagnostics ?? [];
  const viewErrorCount = viewDiagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;

  const groups = useMemo(() => {
    if (!snapshot || !view) return [];
    const resolved = resolveViewGroups(view, snapshot.modules, override);
    return resolved.map((group) => ({
      ...group,
      modules: group.moduleIds
        .map((id) => snapshot.modules.find((module) => module.id === id))
        .filter((module): module is NonNullable<typeof module> => Boolean(module))
        .filter(
          (module) =>
            matchesSearch(module, search) &&
            (filters.workflow.size === 0 || filters.workflow.has(module.workflow)) &&
            (filters.implementation.size === 0 || filters.implementation.has(module.implementation)),
        ),
    }));
  }, [snapshot, view, override, search, filters]);

  const stats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const module of snapshot?.modules ?? []) {
      counts.set(module.workflow, (counts.get(module.workflow) ?? 0) + 1);
    }
    return counts;
  }, [snapshot]);

  if (!snapshot || !view) return null;

  return (
    <aside className="sidebar">
      <div className="sidebar-section sidebar-overview">
        <h3>模块总览 <span className="count-pill">{snapshot.modules.length}</span></h3>
        <div className="stat-row">
          {Object.entries(WORKFLOW_META).map(([state, meta]) => (
            <span key={state} className="stat" style={{ ['--c' as string]: meta.color }}>
              <i />{meta.label} {stats.get(state) ?? 0}
            </span>
          ))}
        </div>
        <div className="stat-note">
          <span className="stat" style={{ ['--c' as string]: IMPLEMENTATION_META.not_detected.color }}>
            <i />未检测到代码 = 规划存在但路径下无文件（≠ 功能不存在）
          </span>
        </div>
      </div>

      <div className="view-picker-card">
        <div className="view-picker-top">
          <label htmlFor="sidebar-view-select">当前视图</label>
          <span className={`view-kind view-kind-${view.kind}`}>{VIEW_KIND_LABEL[view.kind]}</span>
        </div>
        <select
          id="sidebar-view-select"
          className="view-picker-select"
          value={view.id}
          onChange={(event) => setActiveView(event.target.value)}
          title={view.description}
        >
          {views.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        {viewDiagnostics.length > 0 && (
          <div className={`view-diagnostics ${viewErrorCount > 0 ? 'error' : 'warning'}`}>
            <div className="view-diagnostics-head">
              <strong>{viewErrorCount > 0 ? '视图配置无效，已回退' : '视图配置有提示'}</strong>
              <span>{viewDiagnostics.length} 条</span>
            </div>
            <p>
              {viewErrorCount > 0
                ? '当前使用自动生成的技术分层视图。修正 views.yaml 后重新扫描即可恢复。'
                : '视图仍可使用，但建议检查分组是否遗漏模块或布局是否过于纵向。'}
            </p>
            <details>
              <summary>查看具体文件和字段</summary>
              <ul>
                {viewDiagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${diagnostic.path}-${index}`}>
                    <div className="view-diagnostic-location">
                      <code>{diagnostic.file}</code>
                      <span>{diagnostic.path}{diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}` : ''}</span>
                    </div>
                    <p>{diagnostic.message}</p>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <div className="view-picker-actions">
          <button
            type="button"
            className={editingOrder ? 'on' : ''}
            onClick={() => setEditingOrder((value) => !value)}
          >
            {editingOrder ? '完成排序' : '编排顺序'}
          </button>
          {editingOrder && (
            <button type="button" onClick={resetViewOrder} disabled={!override}>恢复默认</button>
          )}
        </div>
        {editingOrder && (
          <p className="view-edit-hint">使用箭头调整系统分组和模块顺序；仅影响当前浏览器视图，不修改依赖关系。</p>
        )}
      </div>

      {groups.map((group, groupIndex) => (
        <div className="sidebar-section view-group-section" key={group.id}>
          <h3>
            <button
              className={`layer-toggle ${filters.groups.has(group.id) ? 'on' : ''}`}
              onClick={() => toggleViewGroupFilter(group.id)}
              title={`筛选 ${group.label}`}
            >
              <i style={{ background: group.color }} />
              {group.label}
            </button>
            <span className="count-pill">{group.modules.length}</span>
            {editingOrder && (
              <span className="order-buttons">
                <button
                  type="button"
                  aria-label={`上移 ${group.label}`}
                  disabled={groupIndex === 0}
                  onClick={() => moveViewGroup(group.id, -1)}
                >↑</button>
                <button
                  type="button"
                  aria-label={`下移 ${group.label}`}
                  disabled={groupIndex === groups.length - 1}
                  onClick={() => moveViewGroup(group.id, 1)}
                >↓</button>
              </span>
            )}
          </h3>
          <ul className="module-list">
            {group.modules.map((module, moduleIndex) => (
              <li
                key={module.id}
                className={`${selection === module.id ? 'active' : ''} ${editingOrder ? 'editing' : ''}`}
                onClick={() => void select(module.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === 'Enter' && void select(module.id)}
              >
                <span className="dot" style={{ background: WORKFLOW_META[module.workflow].color }} />
                <span className="mlabel">{module.label}</span>
                {module.matchedWorkspacePaths.length === 0 && <span className="nofile" title="未检测到代码文件">∅</span>}
                {module.overlayChanges.length > 0 && <span className="dirty" title={`${module.overlayChanges.length} 个未提交变更`}>⚠</span>}
                {editingOrder && (
                  <span className="order-buttons module-order-buttons" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      aria-label={`上移 ${module.label}`}
                      disabled={moduleIndex === 0}
                      onClick={() => moveViewModule(group.id, module.id, -1)}
                    >↑</button>
                    <button
                      type="button"
                      aria-label={`下移 ${module.label}`}
                      disabled={moduleIndex === group.modules.length - 1}
                      onClick={() => moveViewModule(group.id, module.id, 1)}
                    >↓</button>
                  </span>
                )}
              </li>
            ))}
            {group.modules.length === 0 && <li className="empty">（无匹配模块）</li>}
          </ul>
        </div>
      ))}
    </aside>
  );
}