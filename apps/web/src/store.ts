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
import { ApiError } from './lib/api.js';
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

export interface Filters {
  workflow: Set<WorkflowState>;
  implementation: Set<ImplementationState>;
  layers: Set<string>;
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
  boot: () => Promise<void>;
  setIdentity: (identity: Identity) => void;
  switchProject: (projectId: string) => Promise<void>;
  select: (moduleId: string | null) => Promise<void>;
  setSearch: (q: string) => void;
  toggleWorkflowFilter: (state: WorkflowState) => void;
  toggleImplementationFilter: (state: ImplementationState) => void;
  toggleLayerFilter: (layerId: string) => void;
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
  search: '',
  filters: { workflow: new Set(), implementation: new Set(), layers: new Set() },
  participants: new Map(),
  me: null,
  identity: null,
  wsStatus: 'closed',
  team: [],
  teamDemo: false,
  syncing: false,
  annotationConflict: null,

  boot: async () => {
    try {
      const { projects } = await provider.listProjects();
      const identity = provider.capabilities.identity ? loadIdentity() : null;
      const stored = readStoredProject();
      const fallback = projects.find((p) => p.id === stored) ?? projects[0];
      set({ projects, identity, projectId: fallback?.id ?? null, loadError: null });
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
      search: '',
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
  toggleLayerFilter: (layerId) => {
    const filters = get().filters;
    const next = new Set(filters.layers);
    if (next.has(layerId)) next.delete(layerId);
    else next.add(layerId);
    set({ filters: { ...filters, layers: next } });
  },
  clearFilters: () => set({ filters: { workflow: new Set(), implementation: new Set(), layers: new Set() } }),

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
    try {
      const result = await provider.saveAnnotation(projectId, moduleId, text, expectedRevision, identity.name);
      if (!result.ok) {
        set({ annotationConflict: result.message ?? '保存失败' });
        return false;
      }
      set({ annotationConflict: null });
      await get().select(moduleId); // refresh detail with new revision
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        set({ annotationConflict: '备注已被其他成员修改，已为你加载最新版本，请基于最新内容重试。' });
        await get().select(moduleId);
      } else {
        set({ annotationConflict: `保存失败: ${(err as Error).message}` });
      }
      return false;
    }
  },

  dismissConflict: () => set({ annotationConflict: null }),

  refreshSnapshot: async () => {
    const projectId = get().projectId;
    if (!projectId) return;
    const current = get().snapshot;
    const snapshot = await provider.loadSnapshot(projectId);
    if (!current || snapshot.version >= current.version) {
      set({ snapshot });
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
    set({ snapshot, team: teamRes.team, teamDemo: teamRes.demo, loadError: null });
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
