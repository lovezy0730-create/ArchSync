import { useMemo } from 'react';
import { useStore } from '../store.js';
import { WORKFLOW_META, IMPLEMENTATION_META } from './statusMeta.js';
import { matchesSearch } from '../lib/layout.js';
import { layerColor } from '../lib/layout.js';

export function Sidebar() {
  const snapshot = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const search = useStore((s) => s.search);
  const filters = useStore((s) => s.filters);
  const select = useStore((s) => s.select);
  const toggleLayerFilter = useStore((s) => s.toggleLayerFilter);

  const groups = useMemo(() => {
    if (!snapshot) return [];
    const layers = [...snapshot.layers].sort((a, b) => a.order - b.order);
    return layers.map((layer) => ({
      layer,
      color: layerColor(layer.order),
      modules: snapshot.modules.filter(
        (m) =>
          m.layer === layer.id &&
          matchesSearch(m, search) &&
          (filters.workflow.size === 0 || filters.workflow.has(m.workflow)) &&
          (filters.implementation.size === 0 || filters.implementation.has(m.implementation)),
      ),
    }));
  }, [snapshot, search, filters]);

  const stats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of snapshot?.modules ?? []) counts.set(m.workflow, (counts.get(m.workflow) ?? 0) + 1);
    return counts;
  }, [snapshot]);

  if (!snapshot) return null;

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
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

      {groups.map(({ layer, color, modules }) => (
        <div className="sidebar-section" key={layer.id}>
          <h3>
            <button
              className={`layer-toggle ${filters.layers.has(layer.id) ? 'on' : ''}`}
              onClick={() => toggleLayerFilter(layer.id)}
              title="按住此层筛选画布"
            >
              <i style={{ background: color }} />
              {layer.label}
            </button>
            <span className="count-pill">{modules.length}</span>
          </h3>
          <ul className="module-list">
            {modules.map((m) => (
              <li
                key={m.id}
                className={`${selection === m.id ? 'active' : ''}`}
                onClick={() => void select(m.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && void select(m.id)}
              >
                <span className="dot" style={{ background: WORKFLOW_META[m.workflow].color }} />
                <span className="mlabel">{m.label}</span>
                {m.matchedWorkspacePaths.length === 0 && <span className="nofile" title="未检测到代码文件">∅</span>}
                {m.overlayChanges.length > 0 && <span className="dirty" title={`${m.overlayChanges.length} 个未提交变更`}>⚠</span>}
              </li>
            ))}
            {modules.length === 0 && <li className="empty">（无匹配模块）</li>}
          </ul>
        </div>
      ))}
    </aside>
  );
}
