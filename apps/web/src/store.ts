import { create } from 'zustand';
import type {
  ModuleDetail,
  PresenceParticipant,
  ProjectSummary,
  Snapshot,
  WorkflowState,
  ImplementationState,
  ConfigError,
} from '@archsync/contracts';

import { loadIdentity, saveIdentity, type Identity } from './lib/identity.js';
import { PresenceClient, type PresenceStatus } from './lib/presence-client.js';
import {
  currentMode,
  type ArchSyncMode,
  type DataProvider,
} from './lib/data-provider.js';
import { createServerProvider } from './lib/server-provider.js';
import { createStaticProvider } from './lib/static-provider.js';
import { parseProjectConfig } from '@archsync/config';
import { buildSnapshot } from '@archsync/graph';
import type { ScanResult } from '@archsync/contracts';
import { activeView, resolveViewGroups, snapshotViews, type ViewOrderOverride } from './lib/view-layout.js';

export interface Filters {
  workflow: Set<WorkflowState>;
  implementation: Set<ImplementationState>;
  groups: Set<string>;
}

export interface Me {
  name: string;
  sessionId: string | null;
  color: string | null;
}

export interface YamlImportResult {
  ok: boolean;
  errors?: ConfigError[];
  warnings?: ConfigError[];
  projectId?: string;
  message?: string;
}

interface AppState {
  booted: boolean;
  mode: ArchSyncMode;
  capabilities: DataProvider['capabilities'];
  loadError: string | null;
  projects: ProjectSummary[];
  projectId: string | null;
  snapshot: Snapshot | null;
  moduleDetail: ModuleDetail | null;
  detailLoading: boolean;
  selection: string | null;
  activeViewId: string | null;
  viewOrderOverrides: Record<string, ViewOrderOverride>;
  search: string;
  filters: Filters;
  participants: Map<string, PresenceParticipant>;
  me: Me | null;
  identity: Identity | null;
  wsStatus: PresenceStatus;
  team: Array<{ login: string; name: string; role: string }>;
  teamDemo: boolean;
  syncing: boolean;
  annotationConflict: string | null;
  authMode: 'mock' | 'code' | 'off';
  codeAuthenticated: boolean;
  boot: () => Promise<void>;
  submitAccessCode: (code: string) => Promise<string | null>;
  loadRegistry: () => Promise<void>;
  setRegistryList: (list: unknown[]) => void;
  registryList: unknown[];
  registryAddLocal: (path: string) => Promise<{ ok: boolean; project?: { id: string } }>;
  registryAnalyzeGithub: (owner: string, repo: string) => Promise<{ ok: boolean; facts?: Record<string, unknown> }>;
  loadTimeline: (projectId: string, limit?: number) => Promise<{ events: unknown[] }>;
  setIdentity: (identity: Identity) => void;
  switchProject: (projectId: string) => Promise<void>;
  select: (moduleId: string | null) => Promise<void>;
  setSearch: (q: string) => void;
  setActiveView: (viewId: string) => void;
  moveViewGroup: (groupId: string, direction: -1 | 1) => void;
  moveViewModule: (groupId: string, moduleId: string, direction: -1 | 1) => void;
  resetViewOrder: () => void;
  toggleWorkflowFilter: (state: WorkflowState) => void;
  toggleImplementationFilter: (state: ImplementationState) => void;
  toggleViewGroupFilter: (groupId: string) => void;
  clearFilters: () => void;
  resync: () => Promise<void>;
  saveAnnotation: (moduleId: string, text: string, expectedRevision: number) => Promise<boolean>;
  dismissConflict: () => void;
  refreshSnapshot: () => Promise<void>;
  importYaml: (text: string) => Promise<YamlImportResult>;
}

const provider: DataProvider = currentMode() === 'static' ? createStaticProvider() : createServerProvider();

let presenceClient: PresenceClient | null = null;

function readStoredProject(): string | null {
  try {
    return localStorage.getItem('archsync-project');
  } catch {
    return null;
  }
}

function activeViewStorageKey(projectId: string): string {
  return `archsync-view:${projectId}`;
}

function viewOrderStorageKey(projectId: string, viewId: string): string {
  return `archsync-view-order:${projectId}:${viewId}`;
}

function readStoredView(projectId: string): string | null {
  try {
    return localStorage.getItem(activeViewStorageKey(projectId));
  } catch {
    return null;
  }
}

function readViewOverride(projectId: string, viewId: string): ViewOrderOverride | undefined {
  try {
    const raw = localStorage.getItem(viewOrderStorageKey(projectId, viewId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ViewOrderOverride;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeViewOverride(projectId: string, viewId: string, override: ViewOrderOverride | null): void {
  try {
    const key = viewOrderStorageKey(projectId, viewId);
    if (override) localStorage.setItem(key, JSON.stringify(override));
    else localStorage.removeItem(key);
  } catch { /* storage unavailable: session-only layout */ }
}

function initialViewState(snapshot: Snapshot, projectId: string): {
  activeViewId: string;
  viewOrderOverrides: Record<string, ViewOrderOverride>;
} {
  const views = snapshotViews(snapshot);
  const stored = readStoredView(projectId);
  const selected = views.find((view) => view.id === stored)
    ?? views.find((view) => view.id === snapshot.defaultViewId)
    ?? views[0]!;
  const override = readViewOverride(projectId, selected.id);
  return {
    activeViewId: selected.id,
    viewOrderOverrides: override ? { [selected.id]: override } : {},
  };
}

function moveInList<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function connectPresence(
  projectId: string,
  userName: string,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
): void {
  if (!provider.capabilities.presence) return;
  presenceClient?.close();
  const client = new PresenceClient(projectId, userName, {
    onStatus: (status) => set({ wsStatus: status }),
    onSelf: (info) => set({ me: { ...get().me, name: userName, sessionId: info.sessionId, color: info.color } }),
    onParticipants: (incoming) => {
      const map = new Map(get().participants);
      for (const p of incoming) {
        if (get().me?.sessionId === p.sessionId) continue;
        map.set(p.sessionId, p);
      }
      set({ participants: map });
    },
    onParticipantLeft: (sessionId) => {
      const map = new Map(get().participants);
      map.delete(sessionId);
      set({ participants: map });
    },
    onSnapshotPublished: (version) => {
      const current = get().snapshot;
      if (!current || version > current.version) void get().refreshSnapshot();
    },
  });
  presenceClient = client;
  client.connect();
}

export const useStore = create<AppState>((set, get) => ({
  booted: false,
  mode: provider.mode,
  capabilities: provider.capabilities,
  loadError: null,
  projects: [],
  projectId: null,
  snapshot: null,
  moduleDetail: null,
  detailLoading: false,
  selection: null,
  activeViewId: null,
  viewOrderOverrides: {},
  search: '',
  filters: { workflow: new Set(), implementation: new Set(), groups: new Set() },
  participants: new Map(),
  me: null,
  identity: null,
  wsStatus: 'closed',
  team: [],
  teamDemo: false,
  syncing: false,
  annotationConflict: null,
  authMode: 'mock',
  codeAuthenticated: false,

  boot: async () => {
    try {
      // server mode may sit behind access-code auth: probe before data calls
      const me = (await provider.probeAuth?.().catch(() => null)) ?? null;
      const needsCode = me?.mode === 'code' && !me.authenticated;
      const identity = needsCode ? null : provider.capabilities.identity ? loadIdentity() : null;
      set({
        authMode: (me?.mode as 'mock' | 'code' | 'off' | undefined) ?? 'mock',
        codeAuthenticated: me?.mode === 'code' ? Boolean(me.authenticated) : false,
        identity,
      });
      const { projects } = await provider.listProjects();
      const stored = readStoredProject();
      const fallback = projects.find((p) => p.id === stored) ?? projects[0];
      set({ projects, projectId: fallback?.id ?? null, loadError: null });
      if (fallback) {
        await loadProjectData(fallback.id, set);
        if (identity) connectPresence(fallback.id, identity.name, set, get);
      }
    } catch (err) {
      set({
        loadError: (err as Error).message,
        projects: [],
        projectId: null,
      });
    } finally {
      set({ booted: true });
    }
  },

  submitAccessCode: async (code) => {
    const result = await provider.submitAccessCode?.(code);
    if (!result) return '当前模式不支持访问码登录。';
    if (result.ok) {
      set({ codeAuthenticated: true });
      return null;
    }
    return result.message;
  },

  registryList: [],
  setRegistryList: (list) => set({ registryList: list }),
  loadRegistry: async () => {
    const result = await provider.registry?.list();
    if (result) set({ registryList: result.projects });
  },
  registryAddLocal: async (path) => {
    if (!provider.registry) throw new Error('静态模式下项目管理不可用');
    return provider.registry.addLocal(path);
  },
  registryAnalyzeGithub: async (owner, repo) => {
    if (!provider.registry) throw new Error('静态模式下项目管理不可用');
    return provider.registry.analyzeGithub(owner, repo);
  },
  loadTimeline: async (projectId, limit = 100) => {
    if (!provider.registry) throw new Error('静态模式下项目动态不可用');
    return provider.registry.timeline(projectId, limit);
  },

  setIdentity: (identity) => {
    saveIdentity(identity);
    set({ identity, me: { name: identity.name, sessionId: null, color: null } });
    const projectId = get().projectId;
    if (projectId) connectPresence(projectId, identity.name, set, get);
  },

  switchProject: async (projectId) => {
    const identity = get().identity;
    set({
      projectId,
      snapshot: null,
      moduleDetail: null,
      selection: null,
      activeViewId: null,
      viewOrderOverrides: {},
      search: '',
      filters: { workflow: new Set(), implementation: new Set(), groups: new Set() },
      participants: new Map(),
      annotationConflict: null,
      loadError: null,
    });
    try {
      localStorage.setItem('archsync-project', projectId);
    } catch { /* storage unavailable: session-only selection */ }
    await loadProjectData(projectId, set);
    if (identity) connectPresence(projectId, identity.name, set, get);
  },

  select: async (moduleId) => {
    set({ selection: moduleId, moduleDetail: null, annotationConflict: null });
    presenceClient?.sendSelection(moduleId);
    const { projectId } = get();
    if (moduleId && projectId) {
      set({ detailLoading: true });
      try {
        const detail = await provider.loadModule(projectId, moduleId);
        if (get().selection === moduleId) set({ moduleDetail: detail });
      } catch (err) {
        console.warn('module detail failed', err);
      } finally {
        set({ detailLoading: false });
      }
    }
  },

  setSearch: (q) => set({ search: q }),

  setActiveView: (viewId) => {
    const { snapshot, projectId } = get();
    if (!snapshot || !projectId) return;
    if (!snapshotViews(snapshot).some((view) => view.id === viewId)) return;
    const override = readViewOverride(projectId, viewId);
    set({
      activeViewId: viewId,
      filters: { ...get().filters, groups: new Set() },
      viewOrderOverrides: override ? { ...get().viewOrderOverrides, [viewId]: override } : get().viewOrderOverrides,
    });
    try {
      localStorage.setItem(activeViewStorageKey(projectId), viewId);
    } catch { /* session-only */ }
  },

  moveViewGroup: (groupId, direction) => {
    const { snapshot, projectId, activeViewId, viewOrderOverrides } = get();
    if (!snapshot || !projectId) return;
    const view = activeView(snapshot, activeViewId);
    const override = viewOrderOverrides[view.id] ?? {};
    const groups = resolveViewGroups(view, snapshot.modules, override);
    const ids = groups.map((group) => group.id);
    const nextIds = moveInList(ids, ids.indexOf(groupId), direction);
    if (nextIds === ids) return;
    const next: ViewOrderOverride = { ...override, groupOrder: nextIds };
    set({ viewOrderOverrides: { ...viewOrderOverrides, [view.id]: next } });
    writeViewOverride(projectId, view.id, next);
  },

  moveViewModule: (groupId, moduleId, direction) => {
    const { snapshot, projectId, activeViewId, viewOrderOverrides } = get();
    if (!snapshot || !projectId) return;
    const view = activeView(snapshot, activeViewId);
    const override = viewOrderOverrides[view.id] ?? {};
    const groups = resolveViewGroups(view, snapshot.modules, override);
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    const nextIds = moveInList(group.moduleIds, group.moduleIds.indexOf(moduleId), direction);
    if (nextIds === group.moduleIds) return;
    const next: ViewOrderOverride = {
      ...override,
      moduleOrder: { ...(override.moduleOrder ?? {}), [groupId]: nextIds },
    };
    set({ viewOrderOverrides: { ...viewOrderOverrides, [view.id]: next } });
    writeViewOverride(projectId, view.id, next);
  },

  resetViewOrder: () => {
    const { snapshot, projectId, activeViewId, viewOrderOverrides } = get();
    if (!snapshot || !projectId) return;
    const view = activeView(snapshot, activeViewId);
    const next = { ...viewOrderOverrides };
    delete next[view.id];
    set({ viewOrderOverrides: next });
    writeViewOverride(projectId, view.id, null);
  },
  toggleWorkflowFilter: (state) => {
    const filters = get().filters;
    const next = new Set(filters.workflow);
    if (next.has(state)) next.delete(state);
    else next.add(state);
    set({ filters: { ...filters, workflow: next } });
  },
  toggleImplementationFilter: (state) => {
    const filters = get().filters;
    const next = new Set(filters.implementation);
    if (next.has(state)) next.delete(state);
    else next.add(state);
    set({ filters: { ...filters, implementation: next } });
  },
  toggleViewGroupFilter: (groupId) => {
    const filters = get().filters;
    const next = new Set(filters.groups);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    set({ filters: { ...filters, groups: next } });
  },
  clearFilters: () => set({ filters: { workflow: new Set(), implementation: new Set(), groups: new Set() } }),

  resync: async () => {
    if (!provider.capabilities.resync) return; // static mode: hidden in UI
    const projectId = get().projectId;
    if (!projectId || get().syncing) return;
    set({ syncing: true });
    try {
      await provider.resync(projectId);
      await get().refreshSnapshot();
      if (get().selection) await get().select(get().selection);
    } catch (err) {
      console.warn('sync failed', err);
    } finally {
      set({ syncing: false });
    }
  },

  saveAnnotation: async (moduleId, text, expectedRevision) => {
    const { projectId, identity } = get();
    if (!projectId) return false;
    if (!provider.capabilities.annotationWrite) {
      set({ annotationConflict: '静态模式下备注保存不可用；此功能在本地完整模式（pnpm dev）中开放。' });
      return false;
    }
    if (!identity) return false;
    const result = await provider.saveAnnotation(projectId, moduleId, text, expectedRevision, identity.name);
    if (!result.ok) {
      set({ annotationConflict: result.message ?? '保存失败' });
      if (result.conflict) await get().select(moduleId); // reload latest revision
      return false;
    }
    set({ annotationConflict: null });
    await get().select(moduleId); // refresh detail with new revision
    return true;
  },

  dismissConflict: () => set({ annotationConflict: null }),

  refreshSnapshot: async () => {
    const projectId = get().projectId;
    if (!projectId) return;
    const current = get().snapshot;
    const snapshot = await provider.loadSnapshot(projectId);
    if (!current || snapshot.version >= current.version) {
      const views = snapshotViews(snapshot);
      const keepView = views.some((view) => view.id === get().activeViewId);
      set(keepView ? { snapshot } : { snapshot, ...initialViewState(snapshot, projectId) });
      if (get().selection) {
        const fresh = snapshot.modules.find((m) => m.id === get().selection);
        if (fresh) {
          try {
            const detail = await provider.loadModule(projectId, fresh.id);
            set({ moduleDetail: detail });
          } catch { /* keep old detail */ }
        }
      }
    }
  },

  importYaml: async (text) => {
    if (!provider.capabilities.yamlImport) {
      return { ok: false, message: 'YAML 导入预览仅在静态模式下提供（本地模式请直接编辑 .archsync/project.yaml）。' };
    }
    const result = parseProjectConfig(text);
    if (!result.ok || !result.config) {
      return { ok: false, errors: result.errors, warnings: result.warnings };
    }
    const now = new Date().toISOString();
    // honest empty scan: the browser cannot inspect the local workspace, so
    // implementation states stay `unknown` instead of pretending anything
    const scan: ScanResult = {
      ok: false,
      baselineSha: null,
      branch: null,
      baselineFiles: [],
      workspaceFiles: [],
      overlay: [],
      modules: [],
      errors: ['浏览器导入预览不执行本地扫描：实现状态显示为 unknown，依赖仅有规划边'],
      scannedAt: now,
      importAnalysisRan: false,
      observedDependencies: [],
    };
    const snapshot = buildSnapshot({
      config: result.config,
      configWarnings: result.warnings,
      configBlobSha: `import-${Date.now().toString(36)}`,
      scan,
      collab: {
        source: 'unavailable',
        demo: false,
        fetchedAt: now,
        error: '本地导入的 YAML 未连接任何协作数据源',
        team: [],
        issues: [],
        pullRequests: [],
        moduleIssues: {},
        manualApprovals: {},
      },
      version: 1,
      snapshotId: 'local-import',
      now,
    });
    const details: Record<string, ModuleDetail> = {};
    for (const m of snapshot.modules) {
      details[m.id] = { ...m, annotation: { text: '', revision: 1, updatedBy: null, updatedAt: null } };
    }
    const projectId = `import-${result.config.project.id}`;
    provider.registerImported?.(projectId, snapshot, details);
    set({
      projects: [
        ...get().projects.filter((p) => !p.id.startsWith('import-')),
        {
          id: projectId,
          name: `${result.config.project.name}（本地导入预览）`,
          github: result.config.project.github,
          rootDir: '',
          demoCollab: false,
          moduleCount: result.config.modules.length,
          currentVersion: 1,
        },
      ],
    });
    await get().switchProject(projectId);
    return { ok: true, warnings: result.warnings, projectId };
  },
}));

async function loadProjectData(
  projectId: string,
  set: (partial: Partial<AppState>) => void,
): Promise<void> {
  try {
    const [snapshot, teamRes] = await Promise.all([
      provider.loadSnapshot(projectId),
      provider.loadTeam(projectId),
    ]);
    const viewState = initialViewState(snapshot, projectId);
    set({
      snapshot,
      team: teamRes.team,
      teamDemo: teamRes.demo,
      loadError: null,
      ...viewState,
    });
  } catch (err) {
    set({ loadError: (err as Error).message });
    console.error('failed to load project', err);
  }
}

/** exposed for GraphCanvas cursor sending */
export function sendCursorToPeers(position: { x: number; y: number }): void {
  presenceClient?.sendCursor(position);
}
export function sendEditingToPeers(field: string | null): void {
  presenceClient?.sendEditing(field);
}
