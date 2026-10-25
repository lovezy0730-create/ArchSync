import type { ModuleDetail, ProjectSummary, Snapshot } from '@archsync/contracts';
import { STATIC_CAPABILITIES, type AnnotationWriteResult, type DataProvider, type TeamInfo } from './data-provider.js';

interface StaticSnapshotPayload {
  kind: 'archsync-static-snapshot';
  snapshotVersion: number;
  snapshot: Snapshot;
  moduleDetails: Record<string, ModuleDetail>;
}

interface StaticManifest {
  generator: string;
  generatedAt: string;
  sourceCommitSha: string | null;
  dataModes: string[];
  projects: Array<{
    id: string;
    name: string;
    file: string;
    version: number;
    generatedAt: string;
    contentHash: string;
    sourceCommitSha: string;
    githubSource: string;
  }>;
}

/**
 * GitHub Pages mode: everything loads from build-time JSON next to the bundle
 * (BASE_URL/data/…). No /api or /ws request is ever made — the provider has
 * no code path that could produce one.
 */
export function createStaticProvider(): DataProvider {
  const base = import.meta.env.BASE_URL ?? '/';
  const snapshots = new Map<string, StaticSnapshotPayload>();
  const imported = new Map<string, { snapshot: Snapshot; details: Record<string, ModuleDetail> }>();
  let manifest: StaticManifest | null = null;

  const url = (rel: string): string => `${base}${rel}`.replace(/\/{2,}/g, '/');

  async function payloadFor(projectId: string): Promise<StaticSnapshotPayload> {
    const importedEntry = imported.get(projectId);
    if (importedEntry) {
      return {
        kind: 'archsync-static-snapshot',
        snapshotVersion: importedEntry.snapshot.version,
        snapshot: importedEntry.snapshot,
        moduleDetails: importedEntry.details,
      };
    }
    const cached = snapshots.get(projectId);
    if (cached) return cached;
    const project = manifest?.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`静态数据中不存在项目 ${projectId}`);
    const res = await fetch(url(`data/${project.file}`));
    if (!res.ok) {
      throw new Error(`加载静态快照失败: HTTP ${res.status} (${url(`data/${project.file}`)})`);
    }
    const payload = (await res.json()) as StaticSnapshotPayload;
    snapshots.set(projectId, payload);
    return payload;
  }

  return {
    mode: 'static',
    capabilities: STATIC_CAPABILITIES,

    async listProjects() {
      const res = await fetch(url('data/index.json'));
      if (!res.ok) {
        throw new Error(
          `静态快照清单加载失败: HTTP ${res.status}。静态站点缺少 data/index.json —— 请先运行 pnpm build:pages。`,
        );
      }
      manifest = (await res.json()) as StaticManifest;
      const projects: ProjectSummary[] = manifest.projects.map((p) => ({
        id: p.id,
        name: p.name,
        // published bundles describe demo/example projects; a real github
        // pointer would leak private repo names, so it is intentionally blank
        github: { owner: '', repo: '', defaultBranch: '' },
        rootDir: '',
        demoCollab: p.githubSource === 'demo',
        moduleCount: 0,
        currentVersion: p.version,
      }));
      return { projects };
    },

    async loadSnapshot(projectId) {
      return (await payloadFor(projectId)).snapshot;
    },

    async loadModule(projectId, moduleId) {
      const payload = await payloadFor(projectId);
      const detail = payload.moduleDetails[moduleId];
      if (!detail) throw new Error(`模块不存在: ${moduleId}`);
      return detail;
    },

    async loadTeam(projectId): Promise<TeamInfo> {
      const payload = await payloadFor(projectId);
      const team = new Map<string, { login: string; name: string; role: string }>();
      for (const m of payload.snapshot.modules) {
        for (const login of m.owners) team.set(login, { login, name: login, role: 'owner' });
      }
      return { team: [...team.values()], demo: payload.snapshot.githubDemo };
    },

    async saveAnnotation(): Promise<AnnotationWriteResult> {
      // UI disables the editor in static mode; this is a safety net
      return { ok: false, message: '静态模式下备注保存在本地完整模式中可用' };
    },

    async resync(): Promise<void> {
      // UI hides the rescan button in static mode; no-op safety net
    },

    registerImported(projectId, snapshot, details) {
      imported.set(projectId, { snapshot, details });
    },
  };
}
