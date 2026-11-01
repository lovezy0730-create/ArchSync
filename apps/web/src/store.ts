import { create } from 'zustand';
import {
  SnapshotSchema,
  type ModuleDetail,
  type PresenceParticipant,
  type ProjectSummary,
  type Snapshot,
  type WorkflowState,
  type ImplementationState,
  type ConfigError,
} from '@archsync/contracts';

import { loadIdentity, saveIdentity, type Identity } from './lib/identity.js';
import { PresenceClient, type PresenceStatus } from './lib/presence-client.js';
import {
  currentMode,
  type ArchSyncMode,
  type DataProvider,
  type GithubState,
} from './lib/data-provider.js';
import { createServerProvider } from './lib/server-provider.js';
import { createStaticProvider } from './lib/static-provider.js';
import { parseProjectConfig } from '@archsync/config';
import { buildSnapshot } from '@archsync/graph';
import type { ScanResult } from '@archsync/contracts';
import { activeView, resolveViewGroups, snapshotViews, type ViewOrderOverride } from './lib/view-layout.js';
import { loadActiveProject, saveActiveProject } from './lib/code-index-api.js';

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
  /**
   * Snapshot lifecycle is independent from the code index:
   * idle → loading → ready | pending (first rebuild running) | stale (cached,
   * older) | error (with a concrete reason and a retry).
   */
  snapshotStatus: 'idle' | 'loading' | 'ready' | 'pending' | 'stale' | 'error';
  snapshotError: string | null;
  snapshotJobId: string | null;
  ensureSnapshot: () => Promise<void>;
  retrySnapshot: () => Promise<void>;
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
  registryGithubState:(id:string)=>Promise<GithubState>;
  registrySyncGithub: (id:string) => Promise<{ok:boolean;errors:string[]}>;
  registrySetMonitoring: (id:string,enabled:boolean) => Promise<{ok:boolean}>;
  registryRemove: (id:string) => Promise<{ok:boolean}>;
  registryInitPreview: (path:string) => Promise<{yaml:string}>;
  registryInitApply: (path:string,yaml:string) => Promise<{ok:boolean;project?:{id:string}}>;
  registryClone: (owner:string,repo:string,parent:string) => Promise<{path:string}>;
  registryAnalyzeGithub: (owner: string, repo: string) => Promise<{ ok: boolean; project?: {id:string}; facts?: Record<string, unknown> }>;
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
let activeProjectSave = Promise.resolve();

let presenceClient: PresenceClient | null = null;

/** Last good snapshot per project: an error may show it, clearly marked stale. */
const snapshotCache = new Map<string, Snapshot>();
/** Monotonic token so late responses cannot overwrite a newer project/view. */
let snapshotGeneration = 0;

function snapshotCacheKey(projectId: string): string {
  return projectId;
}

function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : null;
}

function errorJobId(err: unknown): string | null {
  const payload = (err as { payload?: { error?: { jobId?: unknown } } })?.payload;
  const jobId = payload?.error?.jobId;
  return typeof jobId === 'string' ? jobId : null;
}

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
    onStatus: (status) => {
      if(get().projectId !== projectId) return;
      set({wsStatus:status,...(status==='connecting'?{participants:new Map()}: {})});
      if(status==='open') void get().refreshSnapshot().catch(() => undefined);
    },
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
  snapshotStatus: 'idle',
  snapshotError: null,
  snapshotJobId: null,
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
      const stored = provider.mode === 'server' ? (await loadActiveProject().catch(() => null)) ?? readStoredProject() : readStoredProject();
      const fallback = stored ? projects.find((p) => p.id === stored) : projects[0];
      set({ projects, projectId: fallback?.id ?? null, loadError: stored && !fallback ? '上次打开的项目不可用，请重新选择或检查路径。' : null });
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
  registryGithubState:async(id)=>{if(!provider.registry) throw new Error('静态模式不支持');return provider.registry.githubState(id);},
  registrySyncGithub: async (id) => {if(!provider.registry) throw new Error('静态模式不支持');return provider.registry.syncGithub(id);},
  registrySetMonitoring: async (id,enabled) => {if(!provider.registry) throw new Error('静态模式不支持');return provider.registry.setMonitoring(id,enabled);},
  registryRemove: async (id) => {if(!provider.registry) throw new Error('静态模式不支持');return provider.registry.remove(id);},
  registryInitPreview: async (path) => { if (!provider.registry) throw new Error('静态模式不支持'); return provider.registry.initPreview(path); },
  registryInitApply: async (path,yaml) => { if (!provider.registry) throw new Error('静态模式不支持'); return provider.registry.initApply(path,yaml); },
  registryClone: async (owner,repo,parent) => { if (!provider.registry) throw new Error('静态模式不支持'); return provider.registry.clone(owner,repo,parent); },
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
      snapshotStatus: 'loading',
      snapshotError: null,
      snapshotJobId: null,
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
    if (provider.mode === 'server') activeProjectSave = activeProjectSave.then(() => saveActiveProject(projectId)).catch(() => undefined);
    await loadProjectData(projectId, set);
    if (identity && get().projectId === projectId) connectPresence(projectId, identity.name, set, get);
  },

  select: async (moduleId) => {
    set({ selection: moduleId, moduleDetail: null, annotationConflict: null });
    presenceClient?.sendSelection(moduleId);
    const { projectId } = get();
    if (moduleId && projectId) {
      set({ detailLoading: true });
      try {
        const detail = await provider.loadModule(projectId, moduleId);
        if (get().projectId === projectId && get().selection === moduleId) set({ moduleDetail: detail });
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

  ensureSnapshot: async () => {
    const { projectId, snapshotStatus } = get();
    if (!projectId) return;
    if (snapshotStatus === 'ready') return;
    await loadProjectData(projectId, set, { snapshotOnly: true });
  },

  retrySnapshot: async () => {
    const projectId = get().projectId;
    if (!projectId) return;
    await loadProjectData(projectId, set, { snapshotOnly: true });
  },

  refreshSnapshot: async () => {
    const projectId = get().projectId;
    if (!projectId) return;
    const generation = ++snapshotGeneration;
    const current = get().snapshot;
    try {
      const parsedSnapshot = SnapshotSchema.safeParse(await provider.loadSnapshot(projectId));
      if (get().projectId !== projectId || generation !== snapshotGeneration) return;
      if (!parsedSnapshot.success) {
        set({
          snapshotStatus: current ? 'stale' : 'error',
          snapshotError: `快照格式与当前版本不兼容：${parsedSnapshot.error.issues[0]?.message ?? 'schema mismatch'}`,
        });
        return;
      }
      const snapshot = parsedSnapshot.data;
      if (!current || snapshot.version >= current.version) {
        snapshotCache.set(snapshotCacheKey(projectId), snapshot);
        const views = snapshotViews(snapshot);
        const keepView = views.some((view) => view.id === get().activeViewId);
        set({
          snapshot,
          snapshotStatus: 'ready',
          snapshotError: null,
          ...(keepView ? {} : initialViewState(snapshot, projectId)),
        });
        if (get().selection) {
          const fresh = snapshot.modules.find((m) => m.id === get().selection);
          if (fresh) {
            try {
              const detail = await provider.loadModule(projectId, fresh.id);
              if (get().projectId === projectId && get().selection === fresh.id) set({ moduleDetail: detail });
            } catch { /* keep old detail */ }
          }
        }
      }
    } catch (err) {
      if (get().projectId !== projectId || generation !== snapshotGeneration) return;
      const code = errorCode(err);
      if (code === 'snapshot_pending') {
        set({ snapshotStatus: 'pending', snapshotError: (err as Error).message, snapshotJobId: errorJobId(err) });
        void pollPendingSnapshot(projectId, generation, set);
      } else {
        set({
          snapshotStatus: current ? 'stale' : 'error',
          snapshotError: `快照刷新失败：${(err as Error).message}`,
        });
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

async function pollPendingSnapshot(
  projectId: string,
  generation: number,
  set: (partial: Partial<AppState>) => void,
): Promise<void> {
  // A first scan may take a while; poll a cheap status endpoint instead of
  // re-issuing /snapshot (which would enqueue more rebuilds).
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    const state = useStore.getState();
    if (state.projectId !== projectId || generation !== snapshotGeneration) return;
    let status: Awaited<ReturnType<NonNullable<DataProvider['snapshotStatus']>>> | null = null;
    try {
      status = (await provider.snapshotStatus?.(projectId)) ?? null;
    } catch {
      continue; // transient: keep waiting until the bounded attempts run out
    }
    if (state.projectId !== projectId || generation !== snapshotGeneration) return;
    if (status?.job?.state === 'error') {
      set({ snapshotStatus: 'error', snapshotError: `架构快照生成失败：${status.job.error ?? '未知原因'}` });
      return;
    }
    if (status?.available) {
      await loadProjectData(projectId, set, { snapshotOnly: true });
      return;
    }
  }
  if (useStore.getState().projectId === projectId && generation === snapshotGeneration) {
    set({
      snapshotStatus: 'error',
      snapshotError: '架构快照仍在生成，已停止自动重试。请点击“重试”或检查扫描日志。',
    });
  }
}

async function loadProjectData(
  projectId: string,
  set: (partial: Partial<AppState>) => void,
  options: { snapshotOnly?: boolean } = {},
): Promise<void> {
  const generation = ++snapshotGeneration;
  const cached = snapshotCache.get(snapshotCacheKey(projectId)) ?? null;
  set({ snapshotStatus: cached ? 'stale' : 'loading', snapshotError: null, snapshotJobId: null });
  const [snapshotResult, teamResult] = await Promise.allSettled([
    provider.loadSnapshot(projectId),
    options.snapshotOnly ? Promise.resolve(null) : provider.loadTeam(projectId),
  ]);
  if (useStore.getState().projectId !== projectId || generation !== snapshotGeneration) return;

  if (snapshotResult.status === 'fulfilled') {
    const parsedSnapshot = SnapshotSchema.safeParse(snapshotResult.value);
    if (!parsedSnapshot.success) {
      set({
        snapshot: cached,
        snapshotStatus: cached ? 'stale' : 'error',
        snapshotError: `快照格式与当前版本不兼容：${parsedSnapshot.error.issues[0]?.message ?? 'schema mismatch'}。请重试或重新扫描。`,
      });
      return;
    }
    const snapshot = parsedSnapshot.data;
    snapshotCache.set(snapshotCacheKey(projectId), snapshot);
    const viewState = initialViewState(snapshot, projectId);
    set({
      snapshot,
      snapshotStatus: 'ready',
      snapshotError: null,
      snapshotJobId: null,
      ...viewState,
    });
  } else {
    const err = snapshotResult.reason as Error;
    const code = errorCode(err);
    const message = err?.message ?? '快照加载失败';
    if (code === 'snapshot_pending') {
      set({
        snapshot: cached,
        snapshotStatus: 'pending',
        snapshotError: message,
        snapshotJobId: errorJobId(err),
      });
      void pollPendingSnapshot(projectId, generation, set);
    } else {
      set({
        snapshot: cached,
        snapshotStatus: cached ? 'stale' : 'error',
        snapshotError: code === 'snapshot_failed' ? message : `架构快照加载失败：${message}`,
        snapshotJobId: errorJobId(err),
      });
    }
    console.error('failed to load snapshot', err);
  }

  if (teamResult.status === 'fulfilled' && teamResult.value) {
    set({ team: teamResult.value.team, teamDemo: teamResult.value.demo });
  } else if (teamResult.status === 'rejected') {
    // Team/collaboration data is optional: never block the architecture graph.
    set({ team: [], teamDemo: false });
  }
}

/** exposed for GraphCanvas cursor sending */
export function sendCursorToPeers(position: { x: number; y: number }): void {
  presenceClient?.sendCursor(position);
}
export function sendEditingToPeers(field: string | null): void {
  presenceClient?.sendEditing(field);
}
