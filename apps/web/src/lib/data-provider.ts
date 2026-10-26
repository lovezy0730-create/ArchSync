import type { ModuleDetail, ProjectSummary, Snapshot } from '@archsync/contracts';

/**
 * Data access abstraction so the same UI runs against the Fastify server
 * (local full mode) or against build-time static JSON (GitHub Pages mode).
 *
 * `capabilities` drive UI enablement: features a mode cannot honestly support
 * are disabled in the interface, never rendered as broken buttons.
 */
export interface DataCapabilities {
  /** WebSocket presence: cursors, selection broadcast, online roster */
  presence: boolean;
  /** server-side annotation writes (optimistic lock) */
  annotationWrite: boolean;
  /** trigger a server-side workspace rescan */
  resync: boolean;
  /** in-browser YAML import preview (static mode) */
  yamlImport: boolean;
  /** display-name login for multi-session presence */
  identity: boolean;
}

export interface TeamInfo {
  team: Array<{ login: string; name: string; role: string }>;
  demo: boolean;
}

export interface AnnotationWriteResult {
  ok: boolean;
  revision?: number;
  text?: string;
  conflict?: boolean;
  message?: string;
}

export interface AuthProbe {
  mode: 'mock' | 'code' | 'off';
  authenticated: boolean;
  identity: string | null;
}

export interface DataProvider {
  readonly mode: 'server' | 'static';
  readonly capabilities: DataCapabilities;
  /** server mode: probe access-code auth state; static returns null */
  probeAuth?(): Promise<AuthProbe | null>;
  /** server mode: exchange access code for a session cookie */
  submitAccessCode?(code: string): Promise<{ ok: true } | { ok: false; message: string }>;
  listProjects(): Promise<{ projects: ProjectSummary[] }>;
  loadSnapshot(projectId: string): Promise<Snapshot>;
  loadModule(projectId: string, moduleId: string): Promise<ModuleDetail>;
  loadTeam(projectId: string): Promise<TeamInfo>;
  saveAnnotation(
    projectId: string,
    moduleId: string,
    text: string,
    expectedRevision: number,
    user: string,
  ): Promise<AnnotationWriteResult>;
  /** rebuild the workspace snapshot (server mode only) */
  resync(projectId: string): Promise<void>;
  /** static mode: registers an in-memory snapshot built from imported YAML */
  registerImported?(projectId: string, snapshot: Snapshot, details: Record<string, ModuleDetail>): void;
}

export const SERVER_CAPABILITIES: DataCapabilities = {
  presence: true,
  annotationWrite: true,
  resync: true,
  yamlImport: false,
  identity: true,
};

export const STATIC_CAPABILITIES: DataCapabilities = {
  presence: false,
  annotationWrite: false,
  resync: false,
  yamlImport: true,
  identity: false,
};

export type ArchSyncMode = 'server' | 'static';

/** Build-time injection (vite define); defaults to the local server mode. */
export function currentMode(): ArchSyncMode {
  return (import.meta.env?.VITE_ARCHSYNC_MODE as ArchSyncMode | undefined) ?? 'server';
}
