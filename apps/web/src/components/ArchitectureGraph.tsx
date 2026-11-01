import { useMemo } from 'react';
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import type { ArchitectureEdgeKind, ArchitectureNode, ArchitectureResponse } from '@archsync/contracts';

/**
 * Generic renderer for the unified architecture projection.
 *
 * The same component draws every level (system/module/file/symbol); the
 * projection decides the nodes and the evidence kind of each edge. Nothing is
 * inferred here: dashed/red edges mean the backend could not resolve them.
 */

const EDGE_STYLE: Record<ArchitectureEdgeKind, { stroke: string; dash?: string; label: string }> = {
  resolved: { stroke: '#58a6ff', label: '已解析' },
  observed: { stroke: '#d29922', label: '观察到' },
  inferred: { stroke: '#a371f7', dash: '2 3', label: '推断' },
  planned: { stroke: '#8b98a9', dash: '6 4', label: '规划' },
  unresolved: { stroke: '#f85149', dash: '4 3', label: '未解析' },
  stale: { stroke: '#6e7681', dash: '3 3', label: '过期' },
};

const KIND_LABEL: Record<string, string> = {
  system: '系统',
  module: '模块',
  file: '文件',
  function: '函数',
  class: '类',
  interface: '接口',
  type: '类型',
  constructor: '构造函数',
  endpoint: '路由',
  unknown: '未解析',
};

const rankOf = (node: ArchitectureNode): number => {
  if (node.kind === 'system') return 0;
  if (node.kind === 'module') return node.parentId?.startsWith('sys:') ? 1 : 1;
  if (node.kind === 'file') return 2;
  if (node.kind === 'unknown') return 2;
  return node.meta?.external ? 2 : 1;
};

const NODE_WIDTH = 260;
const NODE_HEIGHT = 104;
const COLUMN_GAP = 40;
const ROW_GAP = 70;

function layout(nodes: ArchitectureNode[]): Map<string, { x: number; y: number }> {
  const byRank = new Map<number, ArchitectureNode[]>();
  for (const node of nodes) {
    const rank = rankOf(node);
    const list = byRank.get(rank) ?? [];
    list.push(node);
    byRank.set(rank, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const row = byRank.get(rank)!;
    const perRow = Math.max(1, Math.min(4, row.length));
    row.forEach((node, index) => {
      const line = Math.floor(index / perRow);
      const column = index % perRow;
      positions.set(node.id, {
        x: column * (NODE_WIDTH + COLUMN_GAP),
        y: y + line * (NODE_HEIGHT + ROW_GAP),
      });
    });
    y += Math.ceil(row.length / perRow) * (NODE_HEIGHT + ROW_GAP) + 40;
  }
  return positions;
}

const MAX_RENDERED_NODES = 600;

export function ArchitectureGraph({
  response,
  selectedId,
  onSelect,
  changedPaths,
}: {
  response: ArchitectureResponse;
  selectedId: string | null;
  onSelect: (node: ArchitectureNode) => void;
  /** Workspace paths with uncommitted changes, marked on their nodes. */
  changedPaths?: Set<string>;
}) {
  // Never feed ReactFlow duplicate ids, dangling endpoints or thousands of
  // nodes: a malformed projection must degrade, not freeze the renderer.
  const safe = useMemo(() => {
    const seen = new Set<string>();
    const nodes: ArchitectureNode[] = [];
    for (const node of response.nodes) {
      if (!node || typeof node.id !== 'string' || node.id.length === 0 || seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
      if (nodes.length >= MAX_RENDERED_NODES) break;
    }
    const ids = new Set(nodes.map((node) => node.id));
    const edgeIds = new Set<string>();
    const edges = response.edges.filter((edge) => {
      if (!edge || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) return false;
      if (edgeIds.has(edge.id)) return false;
      edgeIds.add(edge.id);
      return true;
    });
    return { nodes, edges, truncated: response.nodes.length > nodes.length };
  }, [response.nodes, response.edges]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of safe.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)!.add(edge.target);
      map.get(edge.target)!.add(edge.source);
    }
    return map;
  }, [safe.edges]);

  const nodes = useMemo<Node[]>(() => {
    const positions = layout(safe.nodes);
    const related = selectedId ? adjacency.get(selectedId) ?? new Set<string>() : null;
    return safe.nodes.map((node) => {
      const dimmed = selectedId !== null && node.id !== selectedId && !related?.has(node.id);
      return {
        id: node.id,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        draggable: true,
        data: {
          label: (
            <button
              type="button"
              className={`arch-node arch-node-${node.kind}${node.id === selectedId ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
              data-node-id={node.id}
              data-node-kind={node.kind}
              data-module-id={node.moduleId ?? undefined}
              data-file-path={node.filePath ?? undefined}
              data-symbol-uid={node.symbolUid ?? undefined}
              onClick={() => onSelect(node)}
              title={node.evidence.map((item) => `${item.source}: ${item.ref}${item.detail ? ` (${item.detail})` : ''}`).join('\n')}
            >
              <span className="arch-node-head">
                <span className={`arch-badge arch-badge-${node.kind}`}>{KIND_LABEL[node.kind] ?? node.kind}</span>
                {node.status !== 'fresh' && <span className={`arch-status arch-status-${node.status}`}>{node.status}</span>}
                {node.planned && <span className="arch-badge arch-badge-planned">规划</span>}
                {node.observed && !node.planned && <span className="arch-badge arch-badge-observed">实际</span>}
                {node.filePath && changedPaths?.has(node.filePath) && <span className="arch-badge arch-badge-changed">未提交</span>}
              </span>
              <strong>{node.label}</strong>
              <span className="arch-node-meta">
                {node.counts.files > 0 && `${node.counts.files} 文件`}
                {node.counts.files > 0 && node.counts.symbols > 0 && ' · '}
                {node.counts.symbols > 0 && `${node.counts.symbols} 符号`}
                {node.counts.files === 0 && node.counts.symbols === 0 && (node.meta?.signature as string | undefined ?? '')}
              </span>
            </button>
          ),
        },
        style: { width: NODE_WIDTH, padding: 0, border: 0, background: 'transparent' },
      } satisfies Node;
    });
  }, [safe.nodes, selectedId, adjacency, onSelect, changedPaths]);

  const edges = useMemo<Edge[]>(() => {
    const related = selectedId ? adjacency.get(selectedId) : null;
    return safe.edges.map((edge) => {
      const style = EDGE_STYLE[edge.kind];
      const highlighted = selectedId === null || (related?.has(edge.source) && related?.has(edge.target)) || edge.source === selectedId || edge.target === selectedId;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.count > 1 ? `${style.label} ×${edge.count}` : style.label,
        markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
        style: { stroke: style.stroke, strokeDasharray: style.dash, opacity: highlighted ? 1 : 0.2 },
        labelStyle: { fill: '#c9d1d9', fontSize: 10 },
        labelBgStyle: { fill: '#18212c' },
        animated: edge.kind === 'unresolved',
      } satisfies Edge;
    });
  }, [safe.edges, selectedId, adjacency]);

  const kinds = [...new Set(safe.edges.map((edge) => edge.kind))];
  const empty = safe.nodes.length === 0;

  return (
    <div className="arch-graph">
      <div className="arch-legend" aria-label="关系图例">
        {kinds.map((kind) => (
          <span key={kind} className={`arch-legend-item arch-legend-${kind}`}>{EDGE_STYLE[kind].label}</span>
        ))}
        {response.stale && <span className="arch-legend-item arch-legend-stale">包含过期索引</span>}
        {safe.truncated && <span className="arch-legend-item arch-legend-stale">仅渲染前 {MAX_RENDERED_NODES} 个节点</span>}
      </div>
      {empty ? (
        <div className="arch-empty">
          <strong>当前层级没有可显示的节点</strong>
          {response.diagnostics.map((diagnostic) => (
            <p key={diagnostic.code} className={`arch-diagnostic arch-diagnostic-${diagnostic.severity}`}>{diagnostic.message}</p>
          ))}
        </div>
      ) : (
        <ReactFlowProvider>
          <ReactFlow
            fitView
            fitViewOptions={{ padding: 0.15, minZoom: 0.55, maxZoom: 1.1 }}
            nodesDraggable
            nodesConnectable={false}
            nodes={nodes}
            edges={edges}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      )}
      {!empty && response.diagnostics.length > 0 && (
        <div className="arch-diagnostics">
          {response.diagnostics.map((diagnostic) => (
            <p key={diagnostic.code} className={`arch-diagnostic arch-diagnostic-${diagnostic.severity}`}>{diagnostic.message}</p>
          ))}
        </div>
      )}
    </div>
  );
}
