import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeChange,
  type XYPosition,
  useReactFlow,
} from '@xyflow/react';
import { useStore, sendCursorToPeers } from '../store.js';
import {
  dependencyClosure,
  isEdgeOnPath,
  layerColor,
  matchesSearch,
} from '../lib/layout.js';
import { ModuleNodeView, type ModuleFlowNode } from './ModuleNode.js';
import { ViewGroupNodeView, type ViewGroupFlowNode } from './ViewGroupNode.js';
import { RemoteCursors } from './RemoteCursors.js';
import { activeView, layoutProjectView, snapshotViews } from '../lib/view-layout.js';

const nodeTypes = { module: ModuleNodeView, 'view-group': ViewGroupNodeView };
type CanvasNode = ModuleFlowNode | ViewGroupFlowNode;
const VIEW_KIND_LABEL = { system: '系统', flow: '流程', layer: '分层' } as const;

export function GraphCanvas() {
  const snapshot = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const search = useStore((s) => s.search);
  const filters = useStore((s) => s.filters);
  const participants = useStore((s) => s.participants);
  const select = useStore((s) => s.select);
  const activeViewId = useStore((s) => s.activeViewId);
  const setActiveView = useStore((s) => s.setActiveView);
  const resetViewOrder = useStore((s) => s.resetViewOrder);
  const viewOrderOverrides = useStore((s) => s.viewOrderOverrides);

  const { screenToFlowPosition, fitView } = useReactFlow();
  const [dragPositions, setDragPositions] = useState<Record<string, XYPosition>>({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastFitProject = useRef<string>('');

  /* ----- project view + deterministic layout ----- */
  const views = useMemo(() => (snapshot ? snapshotViews(snapshot) : []), [snapshot]);
  const currentView = useMemo(
    () => (snapshot ? activeView(snapshot, activeViewId) : null),
    [snapshot, activeViewId],
  );
  const viewOverride = currentView ? viewOrderOverrides[currentView.id] : undefined;

  const baseLayout = useMemo(() => {
    if (!snapshot || !currentView) return null;
    const layout = layoutProjectView(currentView, snapshot.modules, viewOverride);
    const layerById = new Map(snapshot.layers.map((layer) => [layer.id, layer]));
    return { ...layout, layerById };
  }, [snapshot, currentView, viewOverride]);

  /* ----- highlight closure for current selection ----- */
  const closure = useMemo(
    () =>
      snapshot && selection
        ? dependencyClosure(snapshot.modules, selection)
        : { upstream: new Set<string>(), downstream: new Set<string>() },
    [snapshot, selection],
  );

  /* ----- visibility from search + filters ----- */
  const visible = useMemo(() => {
    const map = new Map<string, boolean>();
    const groupByModule = new Map<string, string>();
    for (const group of baseLayout?.groups ?? []) {
      for (const moduleId of group.moduleIds) groupByModule.set(moduleId, group.id);
    }
    for (const m of snapshot?.modules ?? []) {
      const wfOk = filters.workflow.size === 0 || filters.workflow.has(m.workflow);
      const implOk = filters.implementation.size === 0 || filters.implementation.has(m.implementation);
      const groupId = groupByModule.get(m.id);
      const groupOk = filters.groups.size === 0 || (groupId !== undefined && filters.groups.has(groupId));
      map.set(m.id, wfOk && implOk && groupOk);
    }
    return map;
  }, [snapshot, filters, baseLayout]);

  const nodes = useMemo<CanvasNode[]>(() => {
    if (!snapshot || !baseLayout || !currentView) return [];
    const groupNodes: ViewGroupFlowNode[] = baseLayout.groupBoxes.map((group) => ({
      id: `__group__${group.id}`,
      type: 'view-group',
      position: { x: group.x, y: group.y },
      data: {
        label: group.label,
        color: group.color,
        tone: group.tone,
        count: group.moduleIds.length,
        description: currentView.kind === 'flow' ? '流程阶段' : undefined,
      },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      style: { width: group.width, height: group.height },
      hidden: group.moduleIds.length > 0 && group.moduleIds.every((id) => visible.get(id) === false),
    }));

    const moduleNodes: ModuleFlowNode[] = snapshot.modules.map((module) => {
      const related =
        selection !== null &&
        (module.id === selection || closure.upstream.has(module.id) || closure.downstream.has(module.id));
      const dimmed =
        (selection !== null && !related) || (search.trim().length > 0 && !matchesSearch(module, search));
      const override = dragPositions[module.id];
      const pos = override ?? baseLayout.positions.get(module.id) ?? { x: 0, y: 0 };
      return {
        id: module.id,
        type: 'module',
        position: pos,
        zIndex: 2,
        data: {
          module,
          layerLabel: baseLayout.layerById.get(module.layer)?.label ?? module.layer,
          layerColor: layerColor(baseLayout.layerById.get(module.layer)?.order ?? 1),
          dimmed,
          related,
          selectingParticipants: [...participants.values()].filter(
            (p) => p.selectedModuleId === module.id,
          ),
        },
        hidden: visible.get(module.id) === false,
      };
    });
    return [...groupNodes, ...moduleNodes];
  }, [snapshot, baseLayout, currentView, selection, closure, search, dragPositions, participants, visible]);

  const edges = useMemo<Edge[]>(() => {
    if (!snapshot) return [];
    const baseStyle = (kind: string, on: boolean): React.CSSProperties => {
      // planned = declared in YAML only; observed = real import, not planned;
      // confirmed = declared AND backed by real import evidence
      if (on) return { stroke: '#58a6ff', strokeWidth: 2.4 };
      switch (kind) {
        case 'confirmed':
          return { stroke: '#3fb950', strokeWidth: 2 };
        case 'observed':
          return { stroke: '#d29922', strokeWidth: 1.8, strokeDasharray: '6 3' };
        default:
          return { stroke: '#3d4451', strokeWidth: 1.4, strokeDasharray: '4 4' };
      }
    };
    return snapshot.edges.map((edge) => {
      const onPath =
        selection !== null && isEdgeOnPath(edge, selection, closure.upstream, closure.downstream);
      const endpointsVisible = visible.get(edge.source) !== false && visible.get(edge.target) !== false;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        hidden: !endpointsVisible,
        className: onPath ? 'edge-path' : undefined,
        type: 'smoothstep',
        style: baseStyle(edge.kind, onPath),
      };
    });
  }, [snapshot, selection, closure, visible]);

  /* ----- fit view on project / view / order change ----- */
  const layoutKey = `${snapshot?.projectId ?? ''}:${currentView?.id ?? ''}:${baseLayout?.groupBoxes.map((group) => `${group.id}:${group.moduleIds.join(',')}`).join('|') ?? ''}`;
  useEffect(() => {
    if (!snapshot || nodes.length === 0) return;
    if (lastFitProject.current === layoutKey) return;
    lastFitProject.current = layoutKey;
    const t = setTimeout(() => fitView({ padding: 0.15, duration: 500 }), 80);
    return () => clearTimeout(t);
  }, [snapshot, nodes.length, layoutKey, fitView]);

  useEffect(() => {
    setDragPositions({});
  }, [currentView?.id]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const positionChanges = changes.filter(
      (c): c is NodeChange & { type: 'position'; id: string; position?: XYPosition } =>
        c.type === 'position' && c.position !== undefined,
    );
    if (positionChanges.length > 0) {
      setDragPositions((prev) => {
        const next = { ...prev };
        for (const c of positionChanges) next[c.id] = c.position!;
        return next;
      });
    }
  }, []);

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!wrapperRef.current) return;
      const bounds = wrapperRef.current.getBoundingClientRect();
      const position = screenToFlowPosition({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      sendCursorToPeers({ x: position.x, y: position.y });
    },
    [screenToFlowPosition],
  );

  const groupLegend = useMemo(
    () => baseLayout?.groups.map((group) => ({ id: group.id, label: group.label, color: group.color })) ?? [],
    [baseLayout],
  );

  const dependencySummary = useMemo(() => {
    if (!snapshot) return null;
    const counts = { planned: 0, confirmed: 0, observed: 0 };
    for (const e of snapshot.edges) counts[e.kind as keyof typeof counts] += 1;
    return { counts, supported: snapshot.dependencyAnalysis !== 'not_supported' };
  }, [snapshot]);

  return (
    <div className="canvas-wrap" ref={wrapperRef} onMouseMove={onMouseMove}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => { if (node.type === 'module') void select(node.id === selection ? null : node.id); }}
        onPaneClick={() => void select(null)}
        minZoom={0.15}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elevateNodesOnSelect
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#22283110" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          style={{ background: '#10161f', border: '1px solid #262d38', borderRadius: 8 }}
          maskColor="#0d1117cc"
          nodeColor={(node) => node.type === 'view-group' ? 'transparent' : (node as ModuleFlowNode).data?.layerColor ?? '#555'}
        />
      </ReactFlow>
      <RemoteCursors />
      {currentView && (
        <div className="view-toolbar" title={currentView.description || currentView.label}>
          <span className="view-toolbar-label">视图</span>
          <select
            className="view-select"
            value={currentView.id}
            onChange={(event) => setActiveView(event.target.value)}
            aria-label="切换项目视图"
          >
            {views.map((view) => <option key={view.id} value={view.id}>{view.label}</option>)}
          </select>
          <span className={`view-kind view-kind-${currentView.kind}`}>{VIEW_KIND_LABEL[currentView.kind]}</span>
          <button
            className="view-reset-btn"
            type="button"
            onClick={resetViewOrder}
            disabled={!viewOverride}
            title="恢复 views.yaml 中的分组和模块顺序"
          >
            自动整理
          </button>
        </div>
      )}
      <div className="legend-stack">
        {groupLegend.length > 0 && (
          <div className="layer-legend">
            {groupLegend.map((group) => (
              <span key={group.id} className="legend-item">
                <i style={{ background: group.color }} />
                {group.label}
              </span>
            ))}
          </div>
        )}
        {dependencySummary?.supported && (
          <div className="layer-legend edge-legend" title="依赖边证据分类（TS/JS import 分析）">
            <span className="legend-item"><i className="lg lg-confirmed" />已确认 {dependencySummary.counts.confirmed}</span>
            <span className="legend-item"><i className="lg lg-planned" />仅规划 {dependencySummary.counts.planned}</span>
            <span className="legend-item"><i className="lg lg-observed" />代码漂移 {dependencySummary.counts.observed}</span>
          </div>
        )}
      </div>
    </div>
  );
}
