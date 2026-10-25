import type { ModuleState, Snapshot } from '@archsync/contracts';

/** Deterministic layered layout: one column per layer, stable ordering. */
export interface LayoutedNode {
  id: string;
  x: number;
  y: number;
}

export const NODE_WIDTH = 250;
export const NODE_HEIGHT = 96;
export const COL_GAP = 110;
export const ROW_GAP = 28;
export const HEADER_HEIGHT = 56;

export const LAYER_COLORS = ['#58a6ff', '#d2a8ff', '#39c5cf', '#f0883e', '#7ee787', '#ffa657'];

export function layerColor(order: number): string {
  return LAYER_COLORS[(order - 1) % LAYER_COLORS.length] ?? '#8b949e';
}

export function layoutSnapshot(snapshot: Snapshot): {
  nodes: LayoutedNode[];
  columns: Array<{ layerId: string; label: string; color: string; x: number; count: number }>;
  canvasSize: { width: number; height: number };
} {
  const layers = [...snapshot.layers].sort((a, b) => a.order - b.order);
  const nodes: LayoutedNode[] = [];
  const columns: Array<{ layerId: string; label: string; color: string; x: number; count: number }> = [];

  const byLayer = new Map<string, ModuleState[]>();
  for (const layer of layers) byLayer.set(layer.id, []);
  for (const m of snapshot.modules) byLayer.get(m.layer)?.push(m);

  layers.forEach((layer, colIndex) => {
    const x = 40 + colIndex * (NODE_WIDTH + COL_GAP);
    const modules = byLayer.get(layer.id) ?? [];
    columns.push({ layerId: layer.id, label: layer.label, color: layerColor(layer.order), x, count: modules.length });
    modules.forEach((m, rowIndex) => {
      nodes.push({
        id: m.id,
        x,
        y: HEADER_HEIGHT + rowIndex * (NODE_HEIGHT + ROW_GAP),
      });
    });
  });

  const maxRows = Math.max(0, ...columns.map((c) => c.count));
  const width = 40 + columns.length * (NODE_WIDTH + COL_GAP) + 40;
  const height = HEADER_HEIGHT + maxRows * (NODE_HEIGHT + ROW_GAP) + 40;
  return { nodes, columns, canvasSize: { width, height } };
}

/** Transitive upstream (what the module depends on) and downstream sets. */
export function dependencyClosure(
  modules: ModuleState[],
  startId: string,
): { upstream: Set<string>; downstream: Set<string> } {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const upstream = new Set<string>();
  const downstream = new Set<string>();

  const walk = (
    id: string,
    relation: 'plannedDependsOn' | 'dependedOnBy',
    visited: Set<string>,
  ): void => {
    const module = byId.get(id);
    if (!module) return;
    for (const next of module[relation]) {
      if (next === startId || visited.has(next)) continue;
      visited.add(next);
      walk(next, relation, visited);
    }
  };
  walk(startId, 'plannedDependsOn', upstream);
  walk(startId, 'dependedOnBy', downstream);
  return { upstream, downstream };
}

export interface EdgeHighlightInput {
  edges: Snapshot['edges'];
  selectedId: string;
  upstream: Set<string>;
  downstream: Set<string>;
}

export function isEdgeOnPath(
  edge: { source: string; target: string },
  selectedId: string,
  upstream: Set<string>,
  downstream: Set<string>,
): boolean {
  const sel = new Set([selectedId]);
  const upHit = (sel.has(edge.source) || upstream.has(edge.source)) && upstream.has(edge.target);
  const downHit = downstream.has(edge.source) && (sel.has(edge.target) || downstream.has(edge.target));
  return upHit || downHit;
}

export function matchesSearch(module: ModuleState, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    module.id.toLowerCase().includes(q) ||
    module.label.toLowerCase().includes(q) ||
    module.description.toLowerCase().includes(q) ||
    module.owners.some((o) => o.toLowerCase().includes(q))
  );
}
