import { create } from 'zustand';
import type {
  ModuleDetail,
  PresenceParticipant,
  ProjectSummary,
  Snapshot,
  WorkflowState,
  ImplementationState,
} from '@archsync/contracts';
import { api, ApiError } from './lib/api.js';
import { loadIdentity, saveIdentity, type Identity } from './lib/identity.js';
import { PresenceClient, type PresenceStatus } from './lib/presence-client.js';

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

interface AppState {
  booted: boolean;
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
  /** server auth mode, from GET /api/v1/me */
  authMode: 'mock' | 'code' | 'off';
  /** code mode: session cookie verified (login done or boot probe passed) */
  codeAuthenticated: boolean;
  wsStatus: PresenceStatus;
  team: Array<{ login: string; name: string; role: string }>;
  teamDemo: boolean;
  syncing: boolean;
  annotationConflict: string | null;
  authMode: 'mock' | 'code' | 'off';
  codeAuthenticated: boolean;
  boot: () => Promise<void>;
  submitAccessCode: (code: string) => Promise<string | null>;
  submitAccessCode: (code: string) => Promise<string | null>;
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
}

let presenceClient: PresenceClient | null = null;

function readStoredProject(): string | null {
  return localStorage.getItem('archsync-project');
}

async function connectPresence(
  projectId: string,
  userName: string,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
): Promise<void> {
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
  authMode: 'mock',
  codeAuthenticated: false,
  wsStatus: 'closed',
  team: [],
  teamDemo: false,
  syncing: false,
  annotationConflict: null,
  authMode: 'mock',
  codeAuthenticated: false,

  boot: async () => {
    try {
      const [projectsRes, me] = await Promise.all([api.projects(), api.me().catch(() => null)]);
      const needsCode = me?.mode === 'code' && !me.authenticated;
      // a stored identity from a previous session must not auto-enter a
      // deployment that now requires an access code
      const identity = needsCode ? null : loadIdentity();
      const stored = readStoredProject();
      const fallback = projectsRes.projects.find((p) => p.id === stored) ?? projectsRes.projects[0];
      set({
        projects: projectsRes.projects,
        identity,
        projectId: fallback?.id ?? null,
        authMode: me?.mode ?? 'mock',
        codeAuthenticated: me?.mode === 'code' ? me.authenticated : false,
      });
      if (fallback && identity) {
        await loadProjectData(fallback.id, set, get);
        void connectPresence(fallback.id, identity.name, set, get);
      }
    } finally {
      set({ booted: true });
    }
  },

  submitAccessCode: async (code) => {
    try {
      await api.login(code);
      set({ codeAuthenticated: true });
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        return '访问码不正确，请重试。';
      }
      return `验证失败: ${(err as Error).message}`;
    }
  },

  setIdentity: (identity) => {
    saveIdentity(identity);
    set({ identity, me: { name: identity.name, sessionId: null, color: null } });
    const projectId = get().projectId;
    if (projectId) void connectPresence(projectId, identity.name, set, get);
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
    });
    localStorage.setItem('archsync-project', projectId);
    await loadProjectData(projectId, set, get);
    if (identity) void connectPresence(projectId, identity.name, set, get);
  },

  select: async (moduleId) => {
    set({ selection: moduleId, moduleDetail: null, annotationConflict: null });
    presenceClient?.sendSelection(moduleId);
    const { projectId } = get();
    if (moduleId && projectId) {
      set({ detailLoading: true });
      try {
        const detail = await api.module(projectId, moduleId);
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
    const projectId = get().projectId;
    if (!projectId || get().syncing) return;
    set({ syncing: true });
    try {
      const { jobId } = await api.sync(projectId);
      for (let i = 0; i < 60; i++) {
        const job = await api.job(jobId);
        if (job.state === 'done' || job.state === 'error') break;
        await new Promise((r) => setTimeout(r, 150));
      }
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
    if (!projectId || !identity) return false;
    try {
      await api.patchAnnotation(projectId, moduleId, { text, expectedRevision }, identity.name);
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
    const snapshot = await api.snapshot(projectId);
    if (!current || snapshot.version >= current.version) {
      set({ snapshot });
      if (get().selection) {
        const fresh = snapshot.modules.find((m) => m.id === get().selection);
        if (fresh) {
          try {
            const detail = await api.module(projectId, fresh.id);
            set({ moduleDetail: detail });
          } catch { /* keep old detail */ }
        }
      }
    }
  },
}));

async function loadProjectData(
  projectId: string,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
): Promise<void> {
  try {
    const [snapshot, teamRes] = await Promise.all([api.snapshot(projectId), api.team(projectId)]);
    set({ snapshot, team: teamRes.team, teamDemo: teamRes.demo });
  } catch (err) {
    console.error('failed to load project', err);
  }
  void get;
}

/** exposed for GraphCanvas cursor sending */
export function sendCursorToPeers(position: { x: number; y: number }): void {
  presenceClient?.sendCursor(position);
}
export function sendEditingToPeers(field: string | null): void {
  presenceClient?.sendEditing(field);
}
