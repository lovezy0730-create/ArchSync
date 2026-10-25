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
  NODE_HEIGHT,
  NODE_WIDTH,
  dependencyClosure,
  isEdgeOnPath,
  layerColor,
  matchesSearch,
} from '../lib/layout.js';
import { ModuleNodeView, type ModuleFlowNode } from './ModuleNode.js';
import { RemoteCursors } from './RemoteCursors.js';

const nodeTypes = { module: ModuleNodeView };

export function GraphCanvas() {
  const snapshot = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const search = useStore((s) => s.search);
  const filters = useStore((s) => s.filters);
  const participants = useStore((s) => s.participants);
  const select = useStore((s) => s.select);

  const { screenToFlowPosition, fitView } = useReactFlow();
  const [dragPositions, setDragPositions] = useState<Record<string, XYPosition>>({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastFitProject = useRef<string>('');

  /* ----- deterministic base layout ----- */
  const baseLayout = useMemo(() => {
    if (!snapshot) return null;
    const layerById = new Map(snapshot.layers.map((l) => [l.id, l]));
    const byLayer = new Map<string, string[]>();
    for (const layer of [...snapshot.layers].sort((a, b) => a.order - b.order)) {
      byLayer.set(layer.id, []);
    }
    for (const m of snapshot.modules) byLayer.get(m.layer)?.push(m.id);
    const positions = new Map<string, XYPosition>();
    for (const [layerId, ids] of byLayer) {
      const colIndex = [...byLayer.keys()].indexOf(layerId);
      ids.forEach((id, rowIndex) => {
        positions.set(id, {
          x: 40 + colIndex * (NODE_WIDTH + 110),
          y: 56 + rowIndex * (NODE_HEIGHT + 28),
        });
      });
    }
    return { positions, layerById };
  }, [snapshot]);

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
    for (const m of snapshot?.modules ?? []) {
      const wfOk = filters.workflow.size === 0 || filters.workflow.has(m.workflow);
      const implOk = filters.implementation.size === 0 || filters.implementation.has(m.implementation);
      const layerOk = filters.layers.size === 0 || filters.layers.has(m.layer);
      map.set(m.id, wfOk && implOk && layerOk);
    }
    return map;
  }, [snapshot, filters]);

  const nodes = useMemo<ModuleFlowNode[]>(() => {
    if (!snapshot || !baseLayout) return [];
    return snapshot.modules.map((module) => {
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
  }, [snapshot, baseLayout, selection, closure, search, dragPositions, participants, visible]);

  const edges = useMemo<Edge[]>(() => {
    if (!snapshot) return [];
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
        style: onPath
          ? { stroke: '#58a6ff', strokeWidth: 2.2 }
          : { stroke: '#3d4451', strokeWidth: 1.4 },
      };
    });
  }, [snapshot, selection, closure, visible]);

  /* ----- fit view on project / first data ----- */
  useEffect(() => {
    if (!snapshot || nodes.length === 0) return;
    const key = `${snapshot.projectId}`;
    if (lastFitProject.current === key) return;
    lastFitProject.current = key;
    const t = setTimeout(() => fitView({ padding: 0.15, duration: 500 }), 80);
    return () => clearTimeout(t);
  }, [snapshot, nodes.length, fitView]);

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

  const layerLegend = useMemo(() => {
    if (!snapshot) return [];
    return [...snapshot.layers]
      .sort((a, b) => a.order - b.order)
      .map((l) => ({ id: l.id, label: l.label, color: layerColor(l.order) }));
  }, [snapshot]);

  return (
    <div className="canvas-wrap" ref={wrapperRef} onMouseMove={onMouseMove}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => void select(node.id === selection ? null : node.id)}
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
          nodeColor={(node) => (node as ModuleFlowNode).data?.layerColor ?? '#555'}
        />
      </ReactFlow>
      <RemoteCursors />
      {layerLegend.length > 0 && (
        <div className="layer-legend">
          {layerLegend.map((l) => (
            <span key={l.id} className="legend-item">
              <i style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
