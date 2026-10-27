import type {
  ModuleState,
  ProjectViewConfig,
  Snapshot,
  ViewTone,
} from '@archsync/contracts';
import { NODE_HEIGHT, NODE_WIDTH, layerColor } from './layout.js';

export const VIEW_GROUP_PADDING = 20;
export const VIEW_GROUP_WIDTH = NODE_WIDTH + VIEW_GROUP_PADDING * 2;
export const VIEW_GROUP_GAP = 72;
export const VIEW_NODE_GAP = 28;
export const VIEW_HEADER_HEIGHT = 62;

export const VIEW_TONE_COLORS: Record<ViewTone, string> = {
  blue: '#58a6ff',
  purple: '#c89cff',
  cyan: '#39c5cf',
  orange: '#f0883e',
  green: '#7ee787',
  amber: '#d29922',
  red: '#f8514b',
  gray: '#8b98a9',
};

export interface ViewOrderOverride {
  groupOrder?: string[];
  moduleOrder?: Record<string, string[]>;
}

export interface ResolvedViewGroup {
  id: string;
  label: string;
  order: number;
  tone: ViewTone;
  color: string;
  moduleIds: string[];
}

export interface ViewGroupBox {
  id: string;
  label: string;
  tone: ViewTone;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  moduleIds: string[];
}

export interface ViewLayout {
  groups: ResolvedViewGroup[];
  groupBoxes: ViewGroupBox[];
  positions: Map<string, { x: number; y: number }>;
  canvasSize: { width: number; height: number };
}

/** Guarantees the UI always has a usable view, including older snapshots. */
export function snapshotViews(snapshot: Snapshot): ProjectViewConfig[] {
  if (snapshot.views && snapshot.views.length > 0) return snapshot.views;
  return [{
    id: 'auto-layers',
    label: '技术分层',
    kind: 'layer',
    direction: 'LR',
    description: '按层级自动生成的兼容视图',
    groups: [...snapshot.layers]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((layer, index) => ({
        id: layer.id,
        label: layer.label,
        order: index + 1,
        tone: 'blue' as const,
        moduleIds: snapshot.modules.filter((module) => module.layer === layer.id).map((module) => module.id),
      })),
  }];
}

export function activeView(snapshot: Snapshot, viewId: string | null): ProjectViewConfig {
  const views = snapshotViews(snapshot);
  return views.find((view) => view.id === viewId) ?? views.find((view) => view.id === snapshot.defaultViewId) ?? views[0]!;
}

function orderById<T extends { id: string }>(items: T[], override?: string[]): T[] {
  if (!override || override.length === 0) return items;
  const rank = new Map(override.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ar = rank.get(a.id);
    const br = rank.get(b.id);
    if (ar === undefined && br === undefined) return 0;
    if (ar === undefined) return 1;
    if (br === undefined) return -1;
    return ar - br;
  });
}

export function resolveViewGroups(
  view: ProjectViewConfig,
  modules: ModuleState[],
  override?: ViewOrderOverride,
): ResolvedViewGroup[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const seen = new Set<string>();
  const groups: ResolvedViewGroup[] = view.groups.map((group) => {
    const explicit = group.moduleIds.filter((id) => byId.has(id) && !seen.has(id));
    for (const id of explicit) seen.add(id);
    const reordered = orderById(
      explicit.map((id) => ({ id })),
      override?.moduleOrder?.[group.id],
    ).map((item) => item.id);
    return {
      id: group.id,
      label: group.label,
      order: group.order,
      tone: group.tone,
      color: VIEW_TONE_COLORS[group.tone],
      moduleIds: reordered,
    };
  });

  const unassigned = orderById(
    modules.filter((module) => !seen.has(module.id)).map((module) => ({ id: module.id })),
    override?.moduleOrder?.__other__,
  ).map((item) => item.id);
  if (unassigned.length > 0) {
    groups.push({
      id: '__other__',
      label: '其他模块',
      order: Number.MAX_SAFE_INTEGER,
      tone: 'gray',
      color: VIEW_TONE_COLORS.gray,
      moduleIds: unassigned,
    });
  }

  return orderById(
    [...groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    override?.groupOrder,
  );
}

export function layoutProjectView(
  view: ProjectViewConfig,
  modules: ModuleState[],
  override?: ViewOrderOverride,
): ViewLayout {
  const groups = resolveViewGroups(view, modules, override);
  const positions = new Map<string, { x: number; y: number }>();
  const groupBoxes: ViewGroupBox[] = [];

  if (view.direction === 'TB') {
    let y = 36;
    let maxWidth = 0;
    for (const group of groups) {
      const width = Math.max(
        VIEW_GROUP_WIDTH,
        VIEW_GROUP_PADDING * 2 + group.moduleIds.length * NODE_WIDTH + Math.max(0, group.moduleIds.length - 1) * VIEW_NODE_GAP,
      );
      const height = VIEW_HEADER_HEIGHT + NODE_HEIGHT + 26;
      group.moduleIds.forEach((moduleId, index) => {
        positions.set(moduleId, {
          x: 40 + VIEW_GROUP_PADDING + index * (NODE_WIDTH + VIEW_NODE_GAP),
          y: y + VIEW_HEADER_HEIGHT,
        });
      });
      groupBoxes.push({
        id: group.id,
        label: group.label,
        tone: group.tone,
        color: group.color,
        x: 40,
        y,
        width,
        height,
        moduleIds: group.moduleIds,
      });
      maxWidth = Math.max(maxWidth, 40 + width + 40);
      y += height + 48;
    }
    return { groups, groupBoxes, positions, canvasSize: { width: maxWidth, height: y } };
  }

  let maxHeight = 0;
  groups.forEach((group, groupIndex) => {
    const x = 40 + groupIndex * (VIEW_GROUP_WIDTH + VIEW_GROUP_GAP);
    const y = 36;
    const rows = Math.max(1, group.moduleIds.length);
    const height = VIEW_HEADER_HEIGHT + rows * NODE_HEIGHT + Math.max(0, rows - 1) * VIEW_NODE_GAP + 22;
    group.moduleIds.forEach((moduleId, rowIndex) => {
      positions.set(moduleId, {
        x: x + VIEW_GROUP_PADDING,
        y: y + VIEW_HEADER_HEIGHT + rowIndex * (NODE_HEIGHT + VIEW_NODE_GAP),
      });
    });
    groupBoxes.push({
      id: group.id,
      label: group.label,
      tone: group.tone,
      color: group.color,
      x,
      y,
      width: VIEW_GROUP_WIDTH,
      height,
      moduleIds: group.moduleIds,
    });
    maxHeight = Math.max(maxHeight, height);
  });

  return {
    groups,
    groupBoxes,
    positions,
    canvasSize: {
      width: 40 + groups.length * (VIEW_GROUP_WIDTH + VIEW_GROUP_GAP) + 16,
      height: 36 + maxHeight + 40,
    },
  };
}

/** Used by the sidebar when the active view has no explicit group color. */
export function fallbackGroupColor(index: number): string {
  return layerColor(index + 1);
}